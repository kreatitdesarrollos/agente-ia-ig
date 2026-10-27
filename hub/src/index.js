// Hub de la agencia (Cloudflare Worker).
//
// - Usuarios con roles: la agencia ve todos los clientes; cada cliente entra a su panel y ve solo lo suyo.
//   Se invitan con un link de Telegram; el login es con un código que llega a su Telegram.
// - Recibe a Telegram al instante (webhook): botones de aprobación y comandos (/nuevo, /clientes, /panel).
// - Guarda clientes, usuarios, fotos y la fila de propuestas en D1; las imágenes en KV.
// - Publica en Instagram apenas se aprueba. Los clientes conectan su Instagram con "Conectar Instagram" (OAuth).
// - Cada 5 minutos (cron): post diario de cada cliente, reintentos de publicación y renovación de tokens.
// - GitHub Actions (generar.yml) solo genera los posts: pide el trabajo acá y devuelve la propuesta.
//
// Secretos: TELEGRAM_TOKEN, GH_TOKEN, CLAVE_CIFRADO, IG_APP_SECRET (opcional, para "Conectar Instagram").

import PANEL from "./panel.html";
import {
  IG_API, tg, responder, destinatarios, notificar, avisarAgencia, registrar, igGet, igPost, esperar, hex,
  base64ABytes, claveAgente, cifrar, descifrar, horaLocal, textoFinal, despacharWorkflow,
} from "./comun.js";
import { sincronizarPlaySiguiente, proponerResenas, vistaPreviaResena, ejecutarResena, guardarCuentaPlay, probarPlay } from "./play.js";
import { nutricionPendiente, vistaPreviaEmail, ejecutarEmail, saltearEmail, otroEmail, paginaBaja } from "./nutricion.js";
import {
  guardarAds, probarAds, proponerCampana, vistaPreviaAnuncio, ejecutarAnuncio, cambiarEstadoCampana, sincronizarAdsSiguiente,
  crearPublicoInstagram, actualizarPublicoLeads,
} from "./anuncios.js";
import { estadoOficina } from "./oficina.js";
import { apiSeoAgente, vistaPreviaArticulo, ejecutarArticulo, paginaBlog, articulosSemanales, guardarSeo } from "./seo.js";
import { revisarPendientes, usarCorreccion } from "./revisor.js";
import { turnoDePublicacion, publicarProgramadas, publicarEnFacebook } from "./publicador.js";
import { armarResumen, resumenesDiarios } from "./gerente.js";
import { contarIntento, chequearSitios, chequeosInternos, chequeoDiario, apiSeguridadAgente, apiPanelSeguridad } from "./seguridad.js";
import {
  apiProspector, paginaBajaFrio, aprobarLote, ejecutarProspecto, prospeccionProgramada, apiPanelProspeccion, otraProspecto,
} from "./prospeccion.js";
import { guardarInvestigacion, investigacionesSemanales, generarIdea } from "./investigacion.js";
import {
  sincronizarSiguiente, proponerRespuestas, vistaPreviaRespuesta, ejecutarRespuesta, aprendizajes, informesSemanales, generarInforme,
} from "./instagram.js";
import {
  webhookMeta, leadWeb, rutaChat, proponerPendientesMensajes, vistaPreviaMensaje, ejecutarMensaje, enviarPorCanal,
} from "./mensajes.js";
import { guardarAgenda, probarAgenda } from "./agenda.js";
import { crearCobro, avisoMercadoPago, recordarCobros, guardarMercadoPago } from "./cobros.js";

const IG_PERMISOS = "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments," +
  "instagram_business_manage_insights,instagram_business_manage_messages";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.protocol === "http:") return Response.redirect(url.href.replace("http:", "https:"), 301);
    let r;
    try {
      r = await rutear(req, env, ctx);
    } catch (e) {
      console.log("Error:", e.stack || e);
      r = Response.json({ error: String(e.message || e) }, { status: 500 });
    }
    return conEncabezadosDeSeguridad(r);
  },

  async scheduled(evento, env, ctx) {
    ctx.waitUntil(tareasProgramadas(env));
  },
};

// Los que pide el agente de seguridad: solo https, sin adivinar tipos de archivo y sin poder meter el panel en un iframe ajeno.
function conEncabezadosDeSeguridad(r) {
  if (r.status === 101) return r;
  const h = new Headers(r.headers);
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

async function rutear(req, env, ctx) {
  const url = new URL(req.url);
  const ruta = url.pathname;

  if (ruta === "/telegram" && req.method === "POST") return webhookTelegram(req, env, ctx);
  if (ruta === "/ig/webhook" || ruta === "/meta/webhook") return webhookMeta(req, env, ctx);
  const chatRuta = ruta.match(/^\/chat\/([\w-]+)(?:\.js|\/(enviar|mensajes))$/);
  if (chatRuta) return rutaChat(req, env, ctx, chatRuta[1], chatRuta[2] || "js", url);
  const mp = ruta.match(/^\/mp\/([\w-]+)$/);
  if (mp && req.method === "POST") return avisoMercadoPago(req, env, mp[1]);
  const lead = ruta.match(/^\/lead\/([\w-]+)$/);
  if (lead) return leadWeb(req, env, lead[1]);
  const blog = ruta.match(/^\/blog\/([\w-]+)\/([\w-]+)$/);
  if (blog) return paginaBlog(env, blog[1], blog[2]);
  const bajaFrio = ruta.match(/^\/baja-frio\/([\w.-]+)$/);
  if (bajaFrio) return paginaBajaFrio(env, bajaFrio[1]);
  const baja = ruta.match(/^\/baja\/([\w.-]+)$/);
  if (baja) return paginaBaja(req, env, baja[1]);

  // imagen de una propuesta: la usan Instagram, Telegram y el panel (el id no se puede adivinar)
  const img = ruta.match(/^\/img\/([\w-]+)\.jpg$/);
  if (img) {
    const datos = await env.ARCHIVOS.get("img:" + img[1], "arrayBuffer");
    if (!datos) return new Response("no", { status: 404 });
    return new Response(datos, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  }

  const vid = ruta.match(/^\/vid\/([\w-]+)\.mp4$/);
  if (vid) {
    const datos = await env.ARCHIVOS.get("vid:" + vid[1], "arrayBuffer");
    if (!datos) return new Response("no", { status: 404 });
    const total = datos.byteLength, rango = (req.headers.get("Range") || "").match(/bytes=(\d*)-(\d*)/);
    const base = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };
    if (!rango) return new Response(datos, { headers: { ...base, "Content-Length": String(total) } });
    const ini = rango[1] ? Number(rango[1]) : Math.max(0, total - Number(rango[2])), fin = rango[1] && rango[2] ? Math.min(Number(rango[2]), total - 1) : total - 1;
    return new Response(datos.slice(ini, fin + 1), { status: 206, headers: { ...base, "Content-Range": `bytes ${ini}-${fin}/${total}`, "Content-Length": String(fin - ini + 1) } });
  }

  if (ruta === "/" || ruta === "/panel") {
    return new Response(PANEL, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (ruta.startsWith("/api/agente/")) {
    if (req.headers.get("X-Clave") !== (await claveAgente(env))) {
      await contarIntento(env, "api");
      return new Response("no", { status: 403 });
    }
    return apiAgente(req, env, ctx, ruta.slice("/api/agente/".length), url);
  }

  if (ruta === "/api/panel/codigo" && req.method === "POST") return enviarCodigo(req, env);
  if (ruta === "/api/panel/login" && req.method === "POST") return login(req, env);

  const yo = await usuarioDeSesion(req, env);
  if (ruta === "/ig/conectar") return igConectar(env, yo, url);
  if (ruta === "/ig/volver") return igVolver(env, url);
  if (ruta.startsWith("/api/panel/")) {
    if (!yo) return Response.json({ error: "sin sesión" }, { status: 401 });
    return apiPanel(req, env, ctx, yo, ruta.slice("/api/panel/".length), url);
  }

  return new Response("no", { status: 404 });
}

// ---------------------------------------------------------------- permisos

function puede(yo, clienteId) {
  return yo && (yo.rol === "agencia" || yo.cliente_id === clienteId);
}

const SIN_PERMISO = () => Response.json({ error: "no tenés acceso a ese cliente" }, { status: 403 });

// ---------------------------------------------------------------- Telegram

async function webhookTelegram(req, env, ctx) {
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await claveAgente(env))) {
    await contarIntento(env, "webhook");
    return new Response("no", { status: 403 });
  }
  const u = await req.json();
  const mensaje = u.callback_query ? u.callback_query.message : u.message;
  const chat = String(mensaje?.chat?.id ?? "");
  if (!chat) return new Response("ok");
  const yo = await env.DB.prepare("SELECT * FROM usuarios WHERE tg_chat = ? AND activo = 1").bind(chat).first();

  if (u.callback_query) {
    const cb = u.callback_query;
    const [accion, id, extra] = cb.data.split(":");
    if (accion === "corr") {
      const p = await env.DB.prepare("SELECT cliente_id FROM propuestas WHERE id = ?").bind(id).first();
      const ok = p && puede(yo, p.cliente_id);
      const r = ok ? await usarCorreccion(env, id) : { error: "No tenés acceso" };
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: r.error || "✍️ Corrección aplicada" });
      if (r.ok) ctx.waitUntil(enviarVistaPrevia(env, id));
      return new Response("ok");
    }
    if (accion === "lote") {
      const pr = await env.DB.prepare("SELECT cliente_id FROM prospecciones WHERE id = ?").bind(id).first();
      const ok = pr && puede(yo, pr.cliente_id);
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: ok ? "✅ Tanda aprobada: sale respetando el tope diario" : "No tenés acceso" });
      if (ok) ctx.waitUntil(aprobarLote(env, id));
      return new Response("ok");
    }
    if (accion === "idea") {
      const inf = await env.DB.prepare("SELECT cliente_id FROM informes WHERE id = ?").bind(id).first();
      const ok = inf && puede(yo, inf.cliente_id);
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: ok ? "✨ Generando el post..." : "No tenés acceso" });
      if (ok) ctx.waitUntil(generarIdea(env, id, Number(extra), chat));
      return new Response("ok");
    }
    const p = await env.DB.prepare("SELECT cliente_id FROM propuestas WHERE id = ?").bind(id).first();
    if (!p || !puede(yo, p.cliente_id)) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "No tenés acceso a este post" });
      return new Response("ok");
    }
    const textos = { ok: "✅ Publicando...", otra: "🔄 Generando otra...", no: "🗑️ Descartado" };
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: textos[accion] || "Recibido" });
    ctx.waitUntil(accionPropuesta(env, id, accion === "ok" ? "aprobar" : accion === "otra" ? "otra" : "descartar", null, chat));
    return new Response("ok");
  }

  const texto = (u.message?.text || "").trim();
  if (!texto) return new Response("ok");
  ctx.waitUntil(comandoTelegram(env, yo, chat, texto, u.message));
  return new Response("ok");
}

async function comandoTelegram(env, yo, chat, texto, mensaje) {
  const [cmd, ...resto] = texto.split(/\s+/);
  const base = cmd.split("@")[0].toLowerCase();

  // invitación: /start inv_xxxx (viene del link t.me/bot?start=inv_xxxx)
  if (base === "/start" && resto[0]?.startsWith("inv_")) {
    const inv = await env.DB.prepare("SELECT u.*, c.nombre AS cliente_nombre FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id WHERE u.invitacion = ? AND u.activo = 1")
      .bind(resto[0].slice(4)).first();
    if (!inv) return responder(env, chat, "Esa invitación no es válida o ya se usó. Pedile una nueva a quien te invitó.");
    await env.DB.prepare("UPDATE usuarios SET tg_chat = NULL WHERE tg_chat = ?").bind(chat).run();
    await env.DB.prepare("UPDATE usuarios SET tg_chat = ?, invitacion = NULL WHERE id = ?").bind(chat, inv.id).run();
    await registrar(env, inv.cliente_id, "usuario", `${inv.nombre} vinculó su Telegram`);
    return responder(env, chat, `¡Hola ${inv.nombre}! Ya quedaste vinculado${inv.cliente_nombre ? " a " + inv.cliente_nombre : ""}.\n\n` +
      `• Te van a llegar acá los posts para aprobar.\n• Para entrar al panel usá "${inv.usuario}" en ${env.URL_PUBLICA}/panel y te mando el código acá.\n` +
      `• /nuevo tema → genera un post nuevo.`);
  }

  if (!yo) return responder(env, chat, "Este bot es privado. Si te invitaron, abrí el link de invitación que te pasaron.");

  if (base === "/start" || base === "/panel") return responder(env, chat, `Panel: ${env.URL_PUBLICA}/panel (usuario: ${yo.usuario})`);

  if (base === "/video") {
    let cliente = yo.rol === "agencia" ? env.CLIENTE_DEFAULT : yo.cliente_id;
    if (resto[0]?.startsWith("@") && yo.rol === "agencia") cliente = resto.shift().slice(1).toLowerCase();
    const pedido = resto.join(" ").trim();
    await registrar(env, cliente, "generando_video", pedido || "Reel");
    await despacharWorkflow(env, "video.yml", { cliente, pedido, producto: "" });
    return responder(env, chat, `🎬 Armando un Reel${pedido ? " sobre: " + pedido : ""}... (3 a 5 minutos)`);
  }

  if (base === "/resumen") {
    let cliente = yo.rol === "agencia" ? env.CLIENTE_DEFAULT : yo.cliente_id;
    if (resto[0]?.startsWith("@") && yo.rol === "agencia") cliente = resto[0].slice(1).toLowerCase();
    return responder(env, chat, (await armarResumen(env, cliente)).slice(0, 4000));
  }

  if (base === "/clientes" && yo.rol === "agencia") {
    const { results } = await env.DB.prepare("SELECT id, nombre, activo FROM clientes ORDER BY creado").all();
    return responder(env, chat, "Clientes:\n" + results.map((c) => `${c.activo ? "•" : "◦"} ${c.id} — ${c.nombre}`).join("\n") +
      "\n\nPara pedir un post de otro cliente: /nuevo @cliente tema");
  }

  if (base === "/nuevo") {
    let cliente = yo.rol === "agencia" ? env.CLIENTE_DEFAULT : yo.cliente_id;
    if (resto[0]?.startsWith("@") && yo.rol === "agencia") cliente = resto.shift().slice(1).toLowerCase();
    const c = await env.DB.prepare("SELECT id, nombre FROM clientes WHERE id = ?").bind(cliente).first();
    if (!c) return responder(env, chat, `No encontré el cliente "${cliente}". Mirá la lista con /clientes`);
    const pedido = resto.join(" ").trim();
    await responder(env, chat, `✨ Generando un post para ${c.nombre}` + (pedido ? ` sobre: ${pedido}` : "") + "... (1 o 2 minutos)");
    return despacharGenerar(env, c.id, pedido, "");
  }

  // texto suelto: reemplaza el caption de la propuesta a la que respondés (o la última pendiente que podés ver)
  let p = null;
  if (mensaje.reply_to_message) {
    p = await env.DB.prepare("SELECT p.* FROM mensajes_tg m JOIN propuestas p ON p.id = m.propuesta_id WHERE m.chat_id = ? AND m.message_id = ?")
      .bind(chat, mensaje.reply_to_message.message_id).first();
  }
  if (!p) {
    p = await env.DB.prepare("SELECT * FROM propuestas WHERE estado = 'pendiente' AND (? = 'agencia' OR cliente_id = ?) ORDER BY creado DESC LIMIT 1")
      .bind(yo.rol, yo.cliente_id).first();
  }
  if (!p || !puede(yo, p.cliente_id)) return responder(env, chat, "No hay posts pendientes. Mandá /nuevo para generar uno.");
  if (p.estado !== "pendiente") return responder(env, chat, "Ese post ya no está pendiente (" + p.estado + ").");
  const datos = JSON.parse(p.datos);
  if (p.tipo === "email" || p.tipo === "prospecto") {
    datos.cuerpo = texto;
  } else if (p.tipo === "respuesta" || p.tipo === "mensaje" || p.tipo === "resena") {
    datos.respuesta = p.tipo === "resena" ? texto.slice(0, 350) : texto;
    datos.accion = "responder";
  } else {
    datos.caption = texto;
    datos.hashtags = "";
  }
  await env.DB.prepare("UPDATE propuestas SET datos = ?, actualizado = datetime('now') WHERE id = ?").bind(JSON.stringify(datos), p.id).run();
  return enviarVistaPrevia(env, p.id);
}

async function enviarVistaPrevia(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  if (p.tipo === "respuesta") return vistaPreviaRespuesta(env, id);
  if (p.tipo === "mensaje") return vistaPreviaMensaje(env, id);
  if (p.tipo === "resena") return vistaPreviaResena(env, id);
  if (p.tipo === "email") return vistaPreviaEmail(env, id);
  if (p.tipo === "anuncio") return vistaPreviaAnuncio(env, id);
  if (p.tipo === "articulo") return vistaPreviaArticulo(env, id);
  if (p.tipo === "video") {
    const d = JSON.parse(p.datos);
    const botones = { inline_keyboard: [[{ text: "✅ Publicar", callback_data: "ok:" + id }, { text: "🔄 Otro", callback_data: "otra:" + id }, { text: "❌ Descartar", callback_data: "no:" + id }]] };
    for (const chat of await destinatarios(env, p.cliente_id, true)) {
      const v = await tg(env, "sendVideo", { chat_id: chat, video: `${env.URL_PUBLICA}/vid/${id}.mp4?v=${Date.now()}`, caption: `🎬 ${p.cliente_nombre}: Reel "${p.titulo}" (${d.segundos || "?"} s)`, supports_streaming: true });
      const m = await tg(env, "sendMessage", { chat_id: chat, text: `${textoFinal(d)}

— Respondé a este mensaje con otro texto para cambiar el caption.`.slice(0, 4096), reply_markup: botones });
      for (const x of [v, m]) if (x?.result?.message_id) await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, x.result.message_id, id).run();
    }
    return;
  }
  if (p.tipo === "prospecto") {
    const d = JSON.parse(p.datos);
    const botones = { inline_keyboard: [[{ text: "✅ Aprobar", callback_data: "ok:" + id }, { text: "🔄 Otra", callback_data: "otra:" + id }, { text: "❌ Descartar", callback_data: "no:" + id }]] };
    for (const chat of await destinatarios(env, p.cliente_id, true)) {
      const m = await tg(env, "sendMessage", { chat_id: chat, text: `📨 ${p.cliente_nombre}: propuesta a ${d.nombre || ""} <${d.email}>
Asunto: ${d.asunto}

${d.cuerpo}`.slice(0, 4096), reply_markup: botones });
      if (m?.result?.message_id) await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
    }
    return;
  }
  const datos = JSON.parse(p.datos);
  const botones = { inline_keyboard: [[
    { text: "✅ Publicar", callback_data: "ok:" + id },
    { text: "🔄 Otra", callback_data: "otra:" + id },
    { text: "❌ Descartar", callback_data: "no:" + id },
  ]] };
  const texto = textoFinal(datos) + "\n\n— Respondé a este mensaje con texto para reemplazar el caption.";
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const foto = await tg(env, "sendPhoto", { chat_id: chat, photo: `${env.URL_PUBLICA}/img/${id}.jpg?v=${Date.now()}`, caption: `📝 ${p.cliente_nombre}: ${p.titulo}` });
    const msg = await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4096), reply_markup: botones });
    for (const m of [foto, msg]) {
      if (m?.result?.message_id) {
        await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
      }
    }
  }
}

// ---------------------------------------------------------------- propuestas

async function accionPropuesta(env, id, accion, cambios = null, chat = null) {
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  if (!p) return { error: "no existe" };
  if (!["pendiente", "error"].includes(p.estado) && accion !== "otra") {
    if (chat) await responder(env, chat, "Ese post ya no está pendiente (" + p.estado + ").");
    return { error: "ya no está pendiente (" + p.estado + ")" };
  }
  const datos = JSON.parse(p.datos);
  if (cambios) {
    if (cambios.caption !== undefined) datos.caption = cambios.caption;
    if (cambios.hashtags !== undefined) datos.hashtags = cambios.hashtags;
    if (cambios.respuesta !== undefined) datos.respuesta = cambios.respuesta;
    if (cambios.asunto !== undefined) datos.asunto = cambios.asunto;
    if (cambios.cuerpo !== undefined) datos.cuerpo = cambios.cuerpo;
    await env.DB.prepare("UPDATE propuestas SET datos = ?, actualizado = datetime('now') WHERE id = ?").bind(JSON.stringify(datos), id).run();
  }

  if (accion === "aprobar") {
    await registrar(env, p.cliente_id, "aprobada", p.titulo);
    const r = await aprobarSegunTipo(env, id);
    if (r.nota && chat) await responder(env, chat, r.nota);
    return r;
  }
  if (accion === "descartar") {
    await env.DB.prepare("UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    if (p.tipo === "respuesta") await env.DB.prepare("UPDATE comentarios SET estado = 'ignorado' WHERE id = ?").bind(datos.comentario_id).run();
    if (p.tipo === "resena") await env.DB.prepare("UPDATE resenas SET estado = 'ignorado' WHERE id = ?").bind(datos.resena_id).run();
    if (p.tipo === "email") await saltearEmail(env, datos);
    if (p.tipo === "prospecto") await env.DB.prepare("UPDATE prospectos SET estado = 'descartado' WHERE id = ?").bind(datos.prospecto_id).run();
    return { ok: true };
  }
  if (accion === "otra") {
    if (p.estado === "pendiente") {
      await env.DB.prepare("UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    }
    if (p.tipo === "articulo") {
      await registrar(env, p.cliente_id, "escribiendo", "otra versión del artículo");
      await despacharWorkflow(env, "seo.yml", { cliente: p.cliente_id, tema: datos.palabra_clave || "" });
      if (chat) await responder(env, chat, "🌐 Escribiendo otro artículo... (1 o 2 minutos)");
      return { ok: true, nota: "Escribiendo otro artículo (1–2 minutos)" };
    }
    if (p.tipo === "video") {
      await registrar(env, p.cliente_id, "generando_video", datos.pedido || datos.producto || "otro Reel");
      await despacharWorkflow(env, "video.yml", { cliente: p.cliente_id, pedido: datos.pedido || "", producto: datos.producto || "" });
      if (chat) await responder(env, chat, "🎬 Armando otro Reel... (3 a 5 minutos)");
      return { ok: true, nota: "Armando otro Reel (3 a 5 minutos)" };
    }
    if (p.tipo === "prospecto") {
      await otraProspecto(env, datos, chat);
      return { ok: true, nota: "En 1 o 2 minutos llega otra versión" };
    }
    if (p.tipo === "anuncio") {
      if (chat) await responder(env, chat, "🔄 Armando otra propuesta de campaña...");
      try {
        await proponerCampana(env, p.cliente_id, datos.idea || "");
      } catch (e) {
        if (chat) await responder(env, chat, "⚠️ " + e.message);
        return { error: e.message };
      }
      return { ok: true, nota: "Llegó otra propuesta" };
    }
    if (p.tipo === "email") { // el cron escribe otro email en unos minutos
      await otroEmail(env, datos);
      if (chat) await responder(env, chat, "🔄 En unos minutos te propongo otro email.");
      return { ok: true, nota: "En unos minutos llega otro email" };
    }
    if (p.tipo === "resena") { // el cron propone otra respuesta en unos minutos
      await env.DB.prepare("UPDATE resenas SET estado = 'nuevo' WHERE id = ?").bind(datos.resena_id).run();
      if (chat) await responder(env, chat, "🔄 En unos minutos te propongo otra respuesta.");
      return { ok: true, nota: "En unos minutos llega otra respuesta" };
    }
    if (p.tipo === "mensaje") { // el cron propone otro mensaje en unos minutos
      await env.DB.prepare("UPDATE contactos SET por_responder = 1 WHERE id = ?").bind(datos.contacto_id).run();
      if (chat) await responder(env, chat, "🔄 En unos minutos te propongo otro mensaje.");
      return { ok: true, nota: "En unos minutos llega otra propuesta" };
    }
    if (p.tipo === "respuesta") { // el cron propone otra respuesta en unos minutos
      await env.DB.prepare("UPDATE comentarios SET estado = 'nuevo' WHERE id = ?").bind(datos.comentario_id).run();
      if (chat) await responder(env, chat, "🔄 En unos minutos te propongo otra respuesta.");
      return { ok: true, nota: "En unos minutos llega otra respuesta" };
    }
    await despacharGenerar(env, p.cliente_id, datos.pedido || "", datos.producto || "");
    return { ok: true };
  }
  return { error: "acción desconocida" };
}

// Los posts y videos pasan por la cola del Publicador (nunca varios juntos); lo demás sale en el momento.
async function aprobarSegunTipo(env, id) {
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  if (["post", "video"].includes(p.tipo)) {
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
    const turno = await turnoDePublicacion(env, c);
    if (turno.programada) {
      await env.DB.prepare("UPDATE propuestas SET estado = 'programada', programada = ?, actualizado = datetime('now') WHERE id = ?").bind(turno.programada, id).run();
      await registrar(env, c.id, "programada", `${p.titulo} → ${turno.local}`);
      return { ok: true, nota: `🗓️ "${p.titulo}" quedó programado para ${turno.local}, para no publicar varios juntos (Instagram les da menos alcance).` };
    }
  }
  await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
  return ejecutar(env, id);
}

// Ejecuta una propuesta aprobada según su tipo.
function ejecutar(env, id) {
  return env.DB.prepare("SELECT tipo FROM propuestas WHERE id = ?").bind(id).first()
    .then((p) => ({ respuesta: ejecutarRespuesta, mensaje: ejecutarMensaje, resena: ejecutarResena, email: ejecutarEmail, anuncio: ejecutarAnuncio, prospecto: ejecutarProspecto, articulo: ejecutarArticulo }[p?.tipo] || publicar)(env, id));
}

// Publica una propuesta aprobada. Si Instagram todavía está procesando la imagen, queda "aprobada"
// con el contenedor guardado y el cron la termina en la próxima pasada.
async function publicar(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está publicando" };

  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const datos = JSON.parse(p.datos);
  const resultado = JSON.parse(p.resultado || "{}");
  try {
    if (!c.ig_user_id || !c.ig_token) throw new Error("el cliente no tiene Instagram conectado (Clientes → Conectar Instagram)");
    const token = await descifrar(env, c.ig_token);
    const esVideo = p.tipo === "video";
    const archivo = esVideo ? `${env.URL_PUBLICA}/vid/${id}.mp4` : `${env.URL_PUBLICA}/img/${id}.jpg`;
    if (!resultado.contenedor) {
      const r = await igPost(`${IG_API}/${c.ig_user_id}/media`, {
        ...(esVideo ? { media_type: "REELS", video_url: archivo, share_to_feed: "true", ...(datos.portada_ms ? { thumb_offset: String(datos.portada_ms) } : {}) } : { image_url: archivo }),
        caption: textoFinal(datos).slice(0, 2200), access_token: token,
      });
      resultado.contenedor = r.id;
      await guardarResultado(env, id, resultado);
    }
    let listo = false;
    for (let i = 0; i < 8 && !listo; i++) {
      const s = await igGet(`${IG_API}/${resultado.contenedor}`, { fields: "status_code", access_token: token });
      if (s.status_code === "ERROR") throw new Error("Instagram rechazó la imagen: " + JSON.stringify(s));
      listo = s.status_code === "FINISHED";
      if (!listo) await esperar(3000);
    }
    if (!listo) {
      await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ?").bind(id).run();
      return { ok: true, nota: "Instagram sigue procesando la imagen; se publica en unos minutos" };
    }
    const pub = await igPost(`${IG_API}/${c.ig_user_id}/media_publish`, { creation_id: resultado.contenedor, access_token: token });
    const link = await igGet(`${IG_API}/${pub.id}`, { fields: "permalink", access_token: token });
    resultado.media_id = pub.id;
    resultado.enlace = link.permalink || "";
    resultado.facebook = await publicarEnFacebook(env, c, textoFinal(datos), archivo, esVideo);
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, "publicada", p.titulo + " " + resultado.enlace);
    await notificar(env, c.id, `🚀 ¡Publicado en ${c.nombre}! ${resultado.enlace}`);
    return { ok: true, enlace: resultado.enlace };
  } catch (e) {
    resultado.error = String(e.message || e);
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, "error", resultado.error);
    await notificar(env, c.id, `⚠️ No se pudo publicar en ${c.nombre}: ${resultado.error}\nPodés reintentar desde el panel.`);
    return { error: resultado.error };
  }
}

function guardarResultado(env, id, resultado) {
  return env.DB.prepare("UPDATE propuestas SET resultado = ? WHERE id = ?").bind(JSON.stringify(resultado), id).run();
}

// ---------------------------------------------------------------- API para el generador (GitHub Actions)

async function apiAgente(req, env, ctx, ruta, url) {
  if (ruta === "trabajo") {
    const id = url.searchParams.get("cliente");
    const c = await env.DB.prepare("SELECT id, nombre, marca, calendario, zona FROM clientes WHERE id = ?").bind(id).first();
    if (!c) return Response.json({ error: "no existe el cliente" }, { status: 404 });
    const fotos = await env.DB.prepare("SELECT id, producto, nombre, tipo FROM fotos WHERE cliente_id = ? ORDER BY nombre").bind(id).all();
    const historial = await env.DB.prepare(
      "SELECT titulo, json_extract(datos, '$.foto_id') AS foto_id, json_extract(datos, '$.producto') AS producto, actualizado " +
      "FROM propuestas WHERE cliente_id = ? AND estado = 'publicada' ORDER BY actualizado"
    ).bind(id).all();
    return Response.json({ cliente: c, fotos: fotos.results, historial: historial.results, aprendizajes: await aprendizajes(env, id) });
  }

  const foto = ruta.match(/^foto\/([\w-]+)$/);
  if (foto) {
    const f = await env.DB.prepare("SELECT tipo FROM fotos WHERE id = ?").bind(foto[1]).first();
    const datos = await env.ARCHIVOS.get("foto:" + foto[1], "arrayBuffer");
    if (!f || !datos) return new Response("no", { status: 404 });
    return new Response(datos, { headers: { "Content-Type": f.tipo } });
  }

  if (ruta === "propuesta" && req.method === "POST") {
    const b = await req.json();
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(b.cliente_id).first();
    if (!c) return Response.json({ error: "no existe el cliente" }, { status: 404 });
    const id = `${c.id}-${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
    await env.ARCHIVOS.put("img:" + id, base64ABytes(b.imagen_b64));
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'post', ?, ?)")
      .bind(id, c.id, b.titulo, JSON.stringify(b.datos)).run();
    await registrar(env, c.id, "propuesta", b.titulo);
    if (c.auto_publicar) { // sale solo cuando el revisor de calidad lo aprueba (en la próxima pasada del cron)
      const datos = { ...b.datos, auto_pendiente: true };
      await env.DB.prepare("UPDATE propuestas SET datos = ? WHERE id = ?").bind(JSON.stringify(datos), id).run();
      await notificar(env, c.id, `🤖 ${c.nombre} en modo automático: "${b.titulo}" se publica en unos minutos, después de pasar por el revisor de calidad.`);
    } else {
      await enviarVistaPrevia(env, id);
    }
    return Response.json({ ok: true, id });
  }

  const seo = await apiSeoAgente(req, env, ruta, url);
  if (seo) return seo;
  if (ruta.startsWith("seguridad/")) return apiSeguridadAgente(req, env, ruta.slice("seguridad/".length));
  if (ruta.startsWith("prospeccion/")) return apiProspector(req, env, ruta.slice("prospeccion/".length), url);

  if (ruta === "investigacion" && req.method === "GET") {
    const c = await env.DB.prepare("SELECT id, nombre, marca, investigacion FROM clientes WHERE id = ?").bind(url.searchParams.get("cliente")).first();
    if (!c) return Response.json({ error: "no existe el cliente" }, { status: 404 });
    return Response.json({ cliente: { id: c.id, nombre: c.nombre, marca: c.marca }, config: JSON.parse(c.investigacion || "{}") });
  }
  if (ruta === "investigacion" && req.method === "POST") {
    const b = await req.json();
    return Response.json(await guardarInvestigacion(env, b.cliente_id, b.datos));
  }

  if (ruta === "video" && req.method === "POST") {
    const b = await req.json();
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(b.cliente_id).first();
    if (!c) return Response.json({ error: "no existe el cliente" }, { status: 404 });
    const id = `${c.id}-v${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
    await env.ARCHIVOS.put("vid:" + id, base64ABytes(b.video_b64));
    await env.ARCHIVOS.put("img:" + id, base64ABytes(b.portada_b64));
    const datos = { ...b.datos, ...(c.auto_publicar ? { auto_pendiente: true } : {}) };
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'video', ?, ?)").bind(id, c.id, b.titulo, JSON.stringify(datos)).run();
    await registrar(env, c.id, "video", `Reel listo: ${b.titulo}`);
    if (!c.auto_publicar) await enviarVistaPrevia(env, id);
    return Response.json({ ok: true, id });
  }

  if (ruta === "aviso" && req.method === "POST") {
    const b = await req.json();
    await avisarAgencia(env, String(b.texto).slice(0, 4000));
    return Response.json({ ok: true });
  }

  return new Response("no", { status: 404 });
}

// ---------------------------------------------------------------- API del panel

async function apiPanel(req, env, ctx, yo, ruta, url) {
  const metodo = req.method;
  const cuerpo = async () => (metodo === "GET" ? {} : await req.json());
  const agencia = yo.rol === "agencia";

  if (ruta === "salir") {
    await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(cookie(req, "sesion")).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": "sesion=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
  }

  if (ruta === "resumen") {
    const clientes = await env.DB.prepare(
      "SELECT c.id, c.nombre, c.activo, c.auto_publicar, c.hora_post, c.ig_user_id IS NOT NULL AND c.ig_token IS NOT NULL AS ig_ok, " +
      "(SELECT COUNT(*) FROM propuestas p WHERE p.cliente_id = c.id AND p.estado = 'pendiente') AS pendientes, " +
      "(SELECT COUNT(*) FROM propuestas p WHERE p.cliente_id = c.id AND p.estado = 'publicada') AS publicadas " +
      "FROM clientes c WHERE ? OR c.id = ? ORDER BY c.creado"
    ).bind(agencia ? 1 : 0, yo.cliente_id).all();
    return Response.json({
      yo: { nombre: yo.nombre, usuario: yo.usuario, rol: yo.rol, cliente_id: yo.cliente_id },
      clientes: clientes.results, url: env.URL_PUBLICA, ig_oauth: !!(env.IG_APP_ID && env.IG_APP_SECRET),
    });
  }

  if (ruta === "propuestas" && metodo === "GET") {
    const estado = url.searchParams.get("estado") || "pendiente";
    const cliente = agencia ? url.searchParams.get("cliente") || "" : yo.cliente_id;
    const { results } = await env.DB.prepare(
      "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id " +
      "WHERE (? = 'todas' OR p.estado = ?) AND (? = '' OR p.cliente_id = ?) ORDER BY p.creado DESC LIMIT 60"
    ).bind(estado, estado, cliente, cliente).all();
    return Response.json(results.map((p) => ({ ...p, datos: JSON.parse(p.datos), resultado: JSON.parse(p.resultado || "{}") })));
  }

  const cola = ruta.match(/^propuestas\/([\w-]+)\/(ya|desprogramar)$/);
  if (cola && metodo === "POST") {
    const p = await env.DB.prepare("SELECT cliente_id, estado FROM propuestas WHERE id = ?").bind(cola[1]).first();
    if (!p || !puede(yo, p.cliente_id)) return SIN_PERMISO();
    if (p.estado !== "programada") return Response.json({ error: "no está programada" }, { status: 400 });
    if (cola[2] === "desprogramar") {
      await env.DB.prepare("UPDATE propuestas SET estado = 'pendiente', programada = NULL WHERE id = ?").bind(cola[1]).run();
      return Response.json({ ok: true });
    }
    await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ?").bind(cola[1]).run();
    return Response.json(await ejecutar(env, cola[1]));
  }
  const corr = ruta.match(/^propuestas\/([\w-]+)\/corregir$/);
  if (corr && metodo === "POST") {
    const p = await env.DB.prepare("SELECT cliente_id FROM propuestas WHERE id = ?").bind(corr[1]).first();
    if (!p || !puede(yo, p.cliente_id)) return SIN_PERMISO();
    return Response.json(await usarCorreccion(env, corr[1]));
  }
  const accion = ruta.match(/^propuestas\/([\w-]+)\/(aprobar|descartar|otra|reintentar)$/);
  if (accion && metodo === "POST") {
    const p = await env.DB.prepare("SELECT cliente_id FROM propuestas WHERE id = ?").bind(accion[1]).first();
    if (!p || !puede(yo, p.cliente_id)) return SIN_PERMISO();
    const b = await cuerpo();
    if (accion[2] === "reintentar") {
      await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ? AND estado = 'error'").bind(accion[1]).run();
      return Response.json(await ejecutar(env, accion[1]));
    }
    return Response.json(await accionPropuesta(env, accion[1], accion[2], b));
  }

  if (ruta === "generar-articulo" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    await registrar(env, b.cliente, "escribiendo", b.tema || "un artículo para el blog");
    await despacharWorkflow(env, "seo.yml", { cliente: b.cliente, tema: b.tema || "" });
    return Response.json({ ok: true });
  }
  const blogCfg = ruta.match(/^clientes\/([\w-]+)\/blog$/);
  if (blogCfg && metodo === "POST") {
    if (!puede(yo, blogCfg[1])) return SIN_PERMISO();
    try {
      return Response.json(await guardarSeo(env, blogCfg[1], await cuerpo()));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  if (ruta === "generar-video" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    await registrar(env, b.cliente, "generando_video", b.pedido || "Reel");
    await despacharWorkflow(env, "video.yml", { cliente: b.cliente, pedido: b.pedido || "", producto: "" });
    return Response.json({ ok: true });
  }
  if (ruta === "generar" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    await despacharGenerar(env, b.cliente, b.pedido || "", "");
    return Response.json({ ok: true });
  }

  if (ruta === "clientes" && metodo === "POST") {
    if (!agencia) return SIN_PERMISO();
    const b = await cuerpo();
    const id = String(b.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!id || !b.nombre) return Response.json({ error: "faltan id o nombre" }, { status: 400 });
    await env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, ?)").bind(id, b.nombre).run();
    await registrar(env, id, "cliente", "cliente creado");
    return Response.json({ ok: true, id });
  }

  const cli = ruta.match(/^clientes\/([\w-]+)$/);
  if (cli) {
    if (!puede(yo, cli[1])) return SIN_PERMISO();
    if (metodo === "GET") {
      const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(cli[1]).first();
      if (!c) return Response.json({ error: "no existe" }, { status: 404 });
      if (c.ig_token) {
        try {
          c.ig_usuario = (await igGet(`${IG_API}/me`, { fields: "username", access_token: await descifrar(env, c.ig_token) })).username;
        } catch (e) {
          c.ig_error = String(e.message || e);
        }
      }
      c.ig_token = c.ig_token ? "(guardado)" : "";
      c.play_cuenta = c.play_cuenta ? "(guardada)" : "";
      c.ads_token = c.ads_token ? "(guardado)" : "";
      for (const k of ["fb_token", "wa_token", "agenda_cuenta", "mp_token", "wp_config"]) c[k] = c[k] ? "(guardado)" : "";
      return Response.json(c);
    }
    if (metodo === "PUT") {
      const b = await cuerpo();
      const campos = ["nombre", "marca", "calendario", "hora_post", "zona", "auto_publicar", "auto_mensajes", "activo", "ig_user_id", "play_apps", "nutricion"];
      for (const campo of campos) {
        if (b[campo] === undefined) continue;
        if (["calendario", "play_apps", "nutricion"].includes(campo)) JSON.parse(b[campo]); // que sea JSON válido antes de guardarlo
        await env.DB.prepare(`UPDATE clientes SET ${campo} = ? WHERE id = ?`).bind(b[campo], cli[1]).run();
      }
      if (b.ig_token) {
        await env.DB.prepare("UPDATE clientes SET ig_token = ?, ig_token_renovado = datetime('now') WHERE id = ?")
          .bind(await cifrar(env, b.ig_token.trim()), cli[1]).run();
      }
      return Response.json({ ok: true });
    }
  }

  const sus = ruta.match(/^clientes\/([\w-]+)\/suscribir$/);
  if (sus && metodo === "POST") {
    if (!puede(yo, sus[1])) return SIN_PERMISO();
    return Response.json(await suscribirMensajes(env, sus[1]));
  }

  const play = ruta.match(/^clientes\/([\w-]+)\/play(\/probar)?$/);
  if (play && metodo === "POST") {
    if (!puede(yo, play[1])) return SIN_PERMISO();
    if (play[2]) return Response.json(await probarPlay(env, play[1]));
    try {
      return Response.json({ ok: true, email: await guardarCuentaPlay(env, play[1], (await cuerpo()).cuenta) });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  const ads = ruta.match(/^clientes\/([\w-]+)\/ads(\/probar)?$/);
  if (ads && metodo === "POST") {
    if (!puede(yo, ads[1])) return SIN_PERMISO();
    try {
      if (ads[2]) return Response.json(await probarAds(env, ads[1]));
      await guardarAds(env, ads[1], await cuerpo());
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  if (ruta === "anuncios" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return SIN_PERMISO();
    const c = await env.DB.prepare("SELECT ads_cuenta, ads_token IS NOT NULL AS conectado, ads_tope_diario, ads_moneda, ads_link FROM clientes WHERE id = ?").bind(cliente).first();
    const campanas = (await env.DB.prepare("SELECT * FROM campanas WHERE cliente_id = ? ORDER BY creado DESC").bind(cliente).all()).results;
    const audiencias = (await env.DB.prepare("SELECT * FROM audiencias WHERE cliente_id = ?").bind(cliente).all()).results;
    return Response.json({ config: c, campanas, audiencias });
  }
  if (ruta === "anuncios/proponer" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    try {
      return Response.json(await proponerCampana(env, b.cliente, b.idea || ""));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  const camp = ruta.match(/^campanas\/([\w-]+)\/(activar|pausar)$/);
  if (camp && metodo === "POST") {
    const k = await env.DB.prepare("SELECT cliente_id FROM campanas WHERE id = ?").bind(camp[1]).first();
    if (!k || !puede(yo, k.cliente_id)) return SIN_PERMISO();
    try {
      return Response.json(await cambiarEstadoCampana(env, camp[1], camp[2] === "activar"));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  const aud = ruta.match(/^audiencias\/([\w-]+)\/(instagram|leads)$/);
  if (aud && metodo === "POST") {
    if (!puede(yo, aud[1])) return SIN_PERMISO();
    try {
      return Response.json(aud[2] === "instagram" ? await crearPublicoInstagram(env, aud[1]) : await actualizarPublicoLeads(env, aud[1]));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }

  if (ruta === "resenas" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || "";
    if (cliente ? !puede(yo, cliente) : !agencia) return SIN_PERMISO();
    const { results } = await env.DB.prepare(
      "SELECT r.*, cl.nombre AS cliente_nombre FROM resenas r JOIN clientes cl ON cl.id = r.cliente_id WHERE (? = '' OR r.cliente_id = ?) ORDER BY r.fecha DESC LIMIT 100"
    ).bind(cliente, cliente).all();
    return Response.json(results);
  }

  if (ruta === "leads" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || "";
    if (cliente ? !puede(yo, cliente) : !agencia) return SIN_PERMISO();
    const { results } = await env.DB.prepare(
      "SELECT ct.*, cl.nombre AS cliente_nombre, (SELECT texto FROM mensajes m WHERE m.contacto_id = ct.id ORDER BY fecha DESC LIMIT 1) AS ultimo_texto " +
      "FROM contactos ct JOIN clientes cl ON cl.id = ct.cliente_id WHERE (? = '' OR ct.cliente_id = ?) ORDER BY ct.ultimo_mensaje DESC LIMIT 200"
    ).bind(cliente, cliente).all();
    return Response.json(results);
  }
  const cobrar = ruta.match(/^leads\/([\w-]+)\/cobrar$/);
  if (cobrar && metodo === "POST") {
    const ct = await env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(cobrar[1]).first();
    if (!ct || !puede(yo, ct.cliente_id)) return SIN_PERMISO();
    const b = await cuerpo();
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(ct.cliente_id).first();
    try {
      const r = await crearCobro(env, c, ct.id, b.concepto, b.monto);
      let enviado = false;
      if (b.enviar) {
        try {
          const texto = `Te paso el link para pagar ${b.concepto} ($${b.monto}): ${r.link}`;
          const mid = await enviarPorCanal(env, c, ct, texto);
          await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'saliente', ?)").bind(mid || "cobro-" + r.id, c.id, ct.id, texto).run();
          enviado = true;
        } catch (e) {
          return Response.json({ ok: true, link: r.link, aviso: "Link creado, pero no se pudo enviar por el chat: " + e.message });
        }
      }
      return Response.json({ ok: true, link: r.link, enviado });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  if (ruta === "cobros" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return SIN_PERMISO();
    const { results } = await env.DB.prepare(
      "SELECT cb.*, ct.nombre, ct.usuario, ct.telefono FROM cobros cb LEFT JOIN contactos ct ON ct.id = cb.contacto_id WHERE cb.cliente_id = ? ORDER BY cb.creado DESC LIMIT 100"
    ).bind(cliente).all();
    return Response.json(results);
  }
  const conex = ruta.match(/^clientes\/([\w-]+)\/(canales|agenda|agenda-probar|mercadopago)$/);
  if (conex && metodo === "POST") {
    if (!puede(yo, conex[1])) return SIN_PERMISO();
    const b = await cuerpo();
    try {
      if (conex[2] === "agenda") return Response.json(await guardarAgenda(env, conex[1], b));
      if (conex[2] === "agenda-probar") return Response.json(await probarAgenda(env, conex[1]));
      if (conex[2] === "mercadopago") return Response.json(await guardarMercadoPago(env, conex[1], b.token));
      // canales: Messenger / WhatsApp / chat web / publicación
      const set = async (col, val) => env.DB.prepare(`UPDATE clientes SET ${col} = ? WHERE id = ?`).bind(val, conex[1]).run();
      if (b.fb_pagina_id !== undefined) await set("fb_pagina_id", String(b.fb_pagina_id).trim() || null);
      if (b.fb_token) await set("fb_token", await cifrar(env, b.fb_token.trim()));
      if (b.wa_phone_id !== undefined) await set("wa_phone_id", String(b.wa_phone_id).trim() || null);
      if (b.wa_numero !== undefined) await set("wa_numero", String(b.wa_numero).trim() || null);
      if (b.wa_token) await set("wa_token", await cifrar(env, b.wa_token.trim()));
      if (b.chat_config) await set("chat_config", JSON.stringify({ activo: !!b.chat_config.activo, saludo: String(b.chat_config.saludo || "").slice(0, 200), color: b.chat_config.color || "#4b3fb0" }));
      if (b.publicacion_config) await set("publicacion_config", JSON.stringify({ por_dia: Math.min(6, Math.max(1, Number(b.publicacion_config.por_dia) || 2)),
        horarios: (b.publicacion_config.horarios || ["12:00", "19:00"]).filter((h) => /^\d\d:\d\d$/.test(h)).slice(0, 6), facebook: !!b.publicacion_config.facebook }));
      if (b.fb_token && b.fb_pagina_id) { // que Facebook avise al hub de los mensajes de Messenger
        await fetch(`https://graph.facebook.com/v23.0/${b.fb_pagina_id}/subscribed_apps?subscribed_fields=messages,message_echoes&access_token=${encodeURIComponent(b.fb_token.trim())}`, { method: "POST" });
      }
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  }
  const ld = ruta.match(/^leads\/([\w-]+)(\/mensaje)?$/);
  if (ld) {
    const ct = await env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(ld[1]).first();
    if (!ct || !puede(yo, ct.cliente_id)) return SIN_PERMISO();
    if (metodo === "GET") {
      const { results } = await env.DB.prepare("SELECT direccion, texto, fecha FROM mensajes WHERE contacto_id = ? ORDER BY fecha").bind(ct.id).all();
      const emails = (await env.DB.prepare("SELECT paso, asunto, estado, detalle, fecha FROM emails WHERE contacto_id = ? ORDER BY fecha").bind(ct.id).all()).results;
      return Response.json({ ...ct, mensajes: results, emails });
    }
    if (metodo === "PUT") {
      const b = await cuerpo();
      for (const campo of ["etapa", "notas", "nombre", "telefono", "email", "baja"]) {
        if (b[campo] !== undefined) await env.DB.prepare(`UPDATE contactos SET ${campo} = ? WHERE id = ?`).bind(b[campo], ct.id).run();
      }
      return Response.json({ ok: true });
    }
    if (ld[2] && metodo === "POST") { // mensaje escrito a mano desde el panel
      const b = await cuerpo();
      const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(ct.cliente_id).first();
      let mid;
      try {
        mid = await enviarPorCanal(env, c, ct, String(b.texto || "").trim());
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'saliente', ?)")
        .bind(mid || "panel-" + Date.now(), c.id, ct.id, b.texto).run();
      await env.DB.prepare("UPDATE contactos SET por_responder = 0, ultimo_mensaje = datetime('now') WHERE id = ?").bind(ct.id).run();
      await env.DB.prepare(
        "UPDATE propuestas SET estado = 'descartada' WHERE tipo = 'mensaje' AND estado = 'pendiente' AND json_extract(datos, '$.contacto_id') = ?"
      ).bind(ct.id).run();
      return Response.json({ ok: true });
    }
  }

  if (ruta === "fotos" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return SIN_PERMISO();
    const { results } = await env.DB.prepare("SELECT * FROM fotos WHERE cliente_id = ? ORDER BY producto, nombre").bind(cliente).all();
    return Response.json(results);
  }
  if (ruta === "fotos" && metodo === "POST") {
    const form = await req.formData();
    if (!puede(yo, form.get("cliente"))) return SIN_PERMISO();
    const archivo = form.get("archivo");
    const id = crypto.randomUUID().slice(0, 12);
    await env.ARCHIVOS.put("foto:" + id, await archivo.arrayBuffer());
    await env.DB.prepare("INSERT INTO fotos (id, cliente_id, producto, nombre, tipo) VALUES (?, ?, ?, ?, ?)")
      .bind(id, form.get("cliente"), String(form.get("producto") || "").trim().toLowerCase(), archivo.name, archivo.type || "image/png").run();
    return Response.json({ ok: true, id });
  }
  const fot = ruta.match(/^fotos\/([\w-]+)$/);
  if (fot) {
    const f = await env.DB.prepare("SELECT * FROM fotos WHERE id = ?").bind(fot[1]).first();
    if (!f || !puede(yo, f.cliente_id)) return SIN_PERMISO();
    if (metodo === "GET") {
      const datos = await env.ARCHIVOS.get("foto:" + fot[1], "arrayBuffer");
      if (!datos) return new Response("no", { status: 404 });
      return new Response(datos, { headers: { "Content-Type": f.tipo, "Cache-Control": "private, max-age=86400" } });
    }
    if (metodo === "DELETE") {
      await env.DB.prepare("DELETE FROM fotos WHERE id = ?").bind(fot[1]).run();
      await env.ARCHIVOS.delete("foto:" + fot[1]);
      return Response.json({ ok: true });
    }
  }

  // equipo: la agencia ve y crea usuarios de cualquier cliente (y de la agencia); cada cliente, los suyos
  if (ruta === "usuarios" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || "";
    if (cliente ? !puede(yo, cliente) : !agencia) return SIN_PERMISO();
    const { results } = await env.DB.prepare(
      "SELECT id, nombre, usuario, rol, cliente_id, tg_chat IS NOT NULL AS vinculado, invitacion, recibe_previas, activo FROM usuarios " +
      "WHERE activo = 1 AND (CASE WHEN ? = '' THEN rol = 'agencia' ELSE cliente_id = ? END) ORDER BY creado"
    ).bind(cliente, cliente).all();
    const bot = await nombreBot(env);
    return Response.json(results.map((u) => ({ ...u, link: u.invitacion ? `https://t.me/${bot}?start=inv_${u.invitacion}` : null, invitacion: undefined })));
  }
  if (ruta === "usuarios" && metodo === "POST") {
    const b = await cuerpo();
    const cliente = b.cliente || null;
    if (cliente ? !puede(yo, cliente) : !agencia) return SIN_PERMISO();
    const usuario = String(b.usuario || "").trim().toLowerCase();
    if (!b.nombre || !usuario) return Response.json({ error: "faltan nombre o usuario" }, { status: 400 });
    if (await env.DB.prepare("SELECT 1 FROM usuarios WHERE usuario = ?").bind(usuario).first()) {
      return Response.json({ error: "ese usuario ya existe" }, { status: 400 });
    }
    const id = crypto.randomUUID().slice(0, 12);
    await env.DB.prepare("INSERT INTO usuarios (id, nombre, usuario, rol, cliente_id, invitacion) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, b.nombre, usuario, cliente ? "cliente" : "agencia", cliente, nuevoCodigoInvitacion()).run();
    await registrar(env, cliente, "usuario", `${b.nombre} invitado por ${yo.nombre}`);
    return Response.json({ ok: true, id });
  }
  const usu = ruta.match(/^usuarios\/([\w-]+)(\/invitacion)?$/);
  if (usu) {
    const u = await env.DB.prepare("SELECT * FROM usuarios WHERE id = ?").bind(usu[1]).first();
    if (!u || (u.cliente_id ? !puede(yo, u.cliente_id) : !agencia)) return SIN_PERMISO();
    if (usu[2] && metodo === "POST") {
      await env.DB.prepare("UPDATE usuarios SET invitacion = ?, tg_chat = NULL WHERE id = ?").bind(nuevoCodigoInvitacion(), u.id).run();
      return Response.json({ ok: true });
    }
    if (metodo === "PUT") {
      const b = await cuerpo();
      if (b.recibe_previas !== undefined) await env.DB.prepare("UPDATE usuarios SET recibe_previas = ? WHERE id = ?").bind(b.recibe_previas ? 1 : 0, u.id).run();
      return Response.json({ ok: true });
    }
    if (metodo === "DELETE") {
      if (u.id === yo.id) return Response.json({ error: "no podés borrarte a vos mismo" }, { status: 400 });
      await env.DB.prepare("UPDATE usuarios SET activo = 0, tg_chat = NULL, invitacion = NULL, usuario = usuario || '#' || id WHERE id = ?").bind(u.id).run();
      await env.DB.prepare("DELETE FROM sesiones WHERE usuario_id = ?").bind(u.id).run();
      return Response.json({ ok: true });
    }
  }

  if (ruta === "resultados" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || (agencia ? "" : yo.cliente_id);
    if (!cliente || !puede(yo, cliente)) return SIN_PERMISO();
    const posts = (await env.DB.prepare(
      "SELECT p.*, pr.titulo FROM publicaciones_ig p LEFT JOIN propuestas pr ON pr.id = p.propuesta_id WHERE p.cliente_id = ? ORDER BY p.fecha DESC LIMIT 60"
    ).bind(cliente).all()).results;
    const informe = await env.DB.prepare("SELECT * FROM informes WHERE cliente_id = ? ORDER BY id DESC LIMIT 1").bind(cliente).first();
    return Response.json({ posts, informe });
  }
  if (ruta === "informes" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(b.cliente).first();
    return Response.json({ ok: true, texto: await generarInforme(env, c) });
  }
  if (ruta === "investigacion" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return SIN_PERMISO();
    const c = await env.DB.prepare("SELECT investigacion FROM clientes WHERE id = ?").bind(cliente).first();
    const { results } = await env.DB.prepare("SELECT id, creado, texto, datos FROM informes WHERE cliente_id = ? AND tipo = 'mercado' ORDER BY id DESC LIMIT 8").bind(cliente).all();
    return Response.json({ config: JSON.parse(c?.investigacion || "{}"), informes: results.map((i) => ({ ...i, datos: JSON.parse(i.datos || "{}") })) });
  }
  if (ruta === "investigacion" && metodo === "PUT") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    const limpiar = (l) => (l || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
    await env.DB.prepare("UPDATE clientes SET investigacion = ? WHERE id = ?")
      .bind(JSON.stringify({ temas: limpiar(b.temas), competidores: limpiar(b.competidores) }), b.cliente).run();
    return Response.json({ ok: true });
  }
  if (ruta === "investigacion/ahora" && metodo === "POST") {
    const b = await cuerpo();
    if (!puede(yo, b.cliente)) return SIN_PERMISO();
    await registrar(env, b.cliente, "investigando", "noticias del rubro y la competencia");
    await despacharWorkflow(env, "investigar.yml", { cliente: b.cliente });
    return Response.json({ ok: true });
  }
  const ide = ruta.match(/^investigacion\/(\d+)\/idea\/(\d+)$/);
  if (ide && metodo === "POST") {
    const inf = await env.DB.prepare("SELECT cliente_id FROM informes WHERE id = ?").bind(ide[1]).first();
    if (!inf || !puede(yo, inf.cliente_id)) return SIN_PERMISO();
    await generarIdea(env, ide[1], Number(ide[2]), null);
    return Response.json({ ok: true });
  }

  if (ruta === "gerente" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || yo.cliente_id;
    if (!puede(yo, cliente)) return SIN_PERMISO();
    return Response.json({ texto: await armarResumen(env, cliente) });
  }

  if (ruta === "oficina" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || yo.cliente_id;
    if (!puede(yo, cliente)) return SIN_PERMISO();
    return Response.json(await estadoOficina(env, cliente));
  }

  if (ruta === "comentarios" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente") || "";
    if (cliente ? !puede(yo, cliente) : !agencia) return SIN_PERMISO();
    const { results } = await env.DB.prepare(
      "SELECT co.*, cl.nombre AS cliente_nombre, p.enlace FROM comentarios co JOIN clientes cl ON cl.id = co.cliente_id " +
      "LEFT JOIN publicaciones_ig p ON p.media_id = co.media_id WHERE (? = '' OR co.cliente_id = ?) ORDER BY co.fecha DESC LIMIT 100"
    ).bind(cliente, cliente).all();
    return Response.json(results);
  }

  const seguridad = await apiPanelSeguridad(req, env, yo, puede, ruta, url);
  if (seguridad) return seguridad;
  const prospeccion = await apiPanelProspeccion(req, env, yo, puede, ruta, url);
  if (prospeccion) return prospeccion;

  if (ruta === "eventos") {
    const { results } = await env.DB.prepare("SELECT * FROM eventos WHERE ? OR cliente_id = ? ORDER BY id DESC LIMIT 100")
      .bind(agencia ? 1 : 0, yo.cliente_id).all();
    return Response.json(results);
  }

  return Response.json({ error: "no existe" }, { status: 404 });
}

function nuevoCodigoInvitacion() {
  return hex(crypto.getRandomValues(new Uint8Array(12)));
}

let botCache = null;
async function nombreBot(env) {
  if (!botCache) botCache = (await tg(env, "getMe", {}))?.result?.username;
  return botCache;
}

// ---------------------------------------------------------------- Conectar Instagram (OAuth de Instagram)

async function igConectar(env, yo, url) {
  const cliente = url.searchParams.get("cliente");
  if (!yo) return Response.redirect(`${env.URL_PUBLICA}/panel`, 302);
  if (!puede(yo, cliente)) return new Response("No tenés acceso a ese cliente", { status: 403 });
  if (!env.IG_APP_ID || !env.IG_APP_SECRET) return new Response("Falta configurar la app de Instagram en el hub (IG_APP_ID / IG_APP_SECRET).", { status: 500 });
  const estado = nuevoCodigoInvitacion();
  await env.ARCHIVOS.put("igestado:" + estado, cliente, { expirationTtl: 900 });
  const destino = new URL("https://www.instagram.com/oauth/authorize");
  destino.search = new URLSearchParams({
    client_id: env.IG_APP_ID, redirect_uri: `${env.URL_PUBLICA}/ig/volver`, response_type: "code", scope: IG_PERMISOS, state: estado,
  });
  return Response.redirect(destino.toString(), 302);
}

async function igVolver(env, url) {
  const volver = (msg) => Response.redirect(`${env.URL_PUBLICA}/panel#ig=${encodeURIComponent(msg)}`, 302);
  const estado = url.searchParams.get("state") || "";
  const cliente = await env.ARCHIVOS.get("igestado:" + estado);
  if (!cliente) return volver("La conexión venció o no es válida. Probá de nuevo.");
  await env.ARCHIVOS.delete("igestado:" + estado);
  if (url.searchParams.get("error")) return volver("Cancelaste la conexión con Instagram.");
  try {
    const corto = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.IG_APP_ID, client_secret: env.IG_APP_SECRET, grant_type: "authorization_code",
        redirect_uri: `${env.URL_PUBLICA}/ig/volver`, code: (url.searchParams.get("code") || "").replace(/#_$/, ""),
      }),
    }).then((r) => r.json());
    if (!corto.access_token) throw new Error(corto.error_message || JSON.stringify(corto));
    const largo = await igGet("https://graph.instagram.com/access_token", {
      grant_type: "ig_exchange_token", client_secret: env.IG_APP_SECRET, access_token: corto.access_token,
    });
    const me = await igGet(`${IG_API}/me`, { fields: "user_id,username", access_token: largo.access_token });
    await env.DB.prepare("UPDATE clientes SET ig_user_id = ?, ig_token = ?, ig_token_renovado = datetime('now') WHERE id = ?")
      .bind(String(me.user_id), await cifrar(env, largo.access_token), cliente).run();
    await registrar(env, cliente, "instagram", "conectado @" + me.username);
    await suscribirMensajes(env, cliente);
    return volver("Instagram conectado: @" + me.username);
  } catch (e) {
    await registrar(env, cliente, "error", "conectar Instagram: " + e.message);
    return volver("No se pudo conectar Instagram: " + e.message);
  }
}

// Para que Instagram avise al hub de los mensajes directos de esta cuenta.
async function suscribirMensajes(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  try {
    await igPost(`${IG_API}/${c.ig_user_id}/subscribed_apps`, { subscribed_fields: "messages", access_token: await descifrar(env, c.ig_token) });
    await registrar(env, clienteId, "instagram", "mensajes directos activados");
    return { ok: true };
  } catch (e) {
    await registrar(env, clienteId, "error", "activar mensajes directos: " + e.message);
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- login del panel

async function enviarCodigo(req, env) {
  const { usuario } = await req.json().catch(() => ({}));
  const u = await env.DB.prepare("SELECT * FROM usuarios WHERE usuario = ? AND activo = 1 AND tg_chat IS NOT NULL")
    .bind(String(usuario || "").trim().toLowerCase()).first();
  // siempre responde lo mismo, para no revelar qué usuarios existen
  if (u) {
    const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await env.DB.prepare("INSERT OR REPLACE INTO codigos (usuario_id, codigo, vence) VALUES (?, ?, datetime('now', '+10 minutes'))").bind(u.id, codigo).run();
    await responder(env, u.tg_chat, `🔐 Código para entrar al panel: ${codigo}\n(vence en 10 minutos; si no lo pediste vos, ignoralo)`);
  }
  return Response.json({ ok: true });
}

async function login(req, env) {
  const { usuario, codigo } = await req.json();
  const u = await env.DB.prepare(
    "SELECT u.id FROM usuarios u JOIN codigos c ON c.usuario_id = u.id WHERE u.usuario = ? AND u.activo = 1 AND c.codigo = ? AND c.vence > datetime('now')"
  ).bind(String(usuario || "").trim().toLowerCase(), String(codigo || "").trim()).first();
  if (!u) {
    await contarIntento(env, "login");
    return Response.json({ error: "código incorrecto o vencido" }, { status: 401 });
  }
  await env.DB.prepare("DELETE FROM codigos WHERE usuario_id = ?").bind(u.id).run();
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sesiones (token, usuario_id, vence) VALUES (?, ?, datetime('now', '+30 days'))").bind(token, u.id).run();
  // Lax (no Strict) para que la sesión siga al volver de Instagram en "Conectar Instagram"
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": `sesion=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function usuarioDeSesion(req, env) {
  const token = cookie(req, "sesion");
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND s.vence > datetime('now') AND u.activo = 1"
  ).bind(token).first();
}

function cookie(req, nombre) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|; )" + nombre + "=([^;]+)"));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- tareas programadas (cada 5 minutos)

async function tareasProgramadas(env) {
  // 1. post diario de cada cliente a su hora
  const { results: clientes } = await env.DB.prepare("SELECT * FROM clientes WHERE activo = 1").all();
  for (const c of clientes) {
    const { fecha, hora } = horaLocal(c.zona);
    if (hora >= c.hora_post && c.ultimo_diario !== fecha) {
      await env.DB.prepare("UPDATE clientes SET ultimo_diario = ? WHERE id = ?").bind(fecha, c.id).run();
      await despacharGenerar(env, c.id, "", "");
    }
  }

  // 1b. Reels de la semana: con 1 por semana los miércoles, 2 martes y viernes, 3 lunes, miércoles y viernes
  for (const c of clientes) {
    const porSemana = JSON.parse(c.video_config || "{}").por_semana ?? 2;
    const dias = { 1: ["Wed"], 2: ["Tue", "Fri"], 3: ["Mon", "Wed", "Fri"] }[porSemana] || [];
    const { fecha, hora } = horaLocal(c.zona);
    const dia = new Intl.DateTimeFormat("en-US", { timeZone: c.zona, weekday: "short" }).format(new Date());
    if (!c.ig_token || !dias.includes(dia) || hora < "10:00" || c.ultimo_video === fecha) continue;
    await env.DB.prepare("UPDATE clientes SET ultimo_video = ? WHERE id = ?").bind(fecha, c.id).run();
    await registrar(env, c.id, "generando_video", "el Reel de la semana");
    await despacharWorkflow(env, "video.yml", { cliente: c.id, pedido: "", producto: "" });
    break;
  }

  // 2. publicaciones que quedaron esperando a Instagram, o trabadas
  await env.DB.prepare(
    "UPDATE propuestas SET estado = 'aprobada' WHERE estado = 'publicando' AND actualizado < datetime('now', '-15 minutes')"
  ).run();
  const { results: aprobadas } = await env.DB.prepare("SELECT id FROM propuestas WHERE estado = 'aprobada' ORDER BY actualizado LIMIT 3").all();
  for (const p of aprobadas) await ejecutar(env, p.id);

  // 3. tokens de Instagram: se renuevan cada 30 días (vencen a los 60)
  const { results: vencer } = await env.DB.prepare(
    "SELECT id, nombre, ig_token FROM clientes WHERE ig_token IS NOT NULL AND (ig_token_renovado IS NULL OR ig_token_renovado < datetime('now', '-30 days'))"
  ).all();
  for (const c of vencer) {
    try {
      const r = await igGet("https://graph.instagram.com/refresh_access_token", {
        grant_type: "ig_refresh_token", access_token: await descifrar(env, c.ig_token),
      });
      await env.DB.prepare("UPDATE clientes SET ig_token = ?, ig_token_renovado = datetime('now') WHERE id = ?")
        .bind(await cifrar(env, r.access_token), c.id).run();
      await registrar(env, c.id, "token", "token de Instagram renovado");
    } catch (e) {
      await notificar(env, c.id, `⚠️ No pude renovar el token de Instagram de ${c.nombre}: ${e.message}\nVolvé a conectarlo desde el panel.`);
    }
  }

  // 4. estudio de contenido y reputación: métricas y comentarios de un cliente, respuestas propuestas, informe semanal
  await sincronizarSiguiente(env);
  await proponerRespuestas(env);
  await proponerPendientesMensajes(env);
  await sincronizarPlaySiguiente(env);
  await proponerResenas(env);
  await nutricionPendiente(env);
  await recordarCobros(env);
  await articulosSemanales(env);
  await sincronizarAdsSiguiente(env);
  await prospeccionProgramada(env);

  // 5. revisor de calidad (antes de que apruebes, o antes de que salga solo) y resumen diario del gerente
  await revisarPendientes(env, { aprobar: aprobarSegunTipo, enviarVistaPrevia });
  await publicarProgramadas(env, ejecutar);
  await resumenesDiarios(env);

  // 6. seguridad: sitios cada 15 min, el hub por dentro cada hora y el chequeo profundo una vez por día
  await chequearSitios(env);
  await chequeosInternos(env);
  await chequeoDiario(env);
  await informesSemanales(env);
  await investigacionesSemanales(env);

  await env.DB.prepare("DELETE FROM sesiones WHERE vence < datetime('now')").run();
}

// ---------------------------------------------------------------- GitHub (generador)

async function despacharGenerar(env, cliente, pedido, producto) {
  await registrar(env, cliente, "generando", pedido || producto || "el post del día");
  return despacharWorkflow(env, "generar.yml", { cliente, pedido, producto });
}

