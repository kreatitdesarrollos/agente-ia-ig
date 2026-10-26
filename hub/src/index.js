// Hub de la agencia (Cloudflare Worker).
//
// - Recibe a Telegram al instante (webhook): botones de aprobación y comandos (/nuevo, /clientes, /panel).
// - Guarda clientes, fotos y la fila de propuestas en D1; las imágenes en KV.
// - Publica en Instagram apenas aprobás (sin esperar a GitHub).
// - Cada 5 minutos (cron): genera el post diario de cada cliente, reintenta publicaciones y renueva tokens.
// - Sirve el panel de administración en /panel (login con código por Telegram).
// - GitHub Actions (generar.yml) solo genera los posts: pide el trabajo acá y devuelve la propuesta.
//
// Secretos: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (tu chat de admin), GH_TOKEN, CLAVE_CIFRADO.

import PANEL from "./panel.html";

const IG_API = "https://graph.instagram.com/v23.0";

export default {
  async fetch(req, env, ctx) {
    try {
      return await rutear(req, env, ctx);
    } catch (e) {
      console.log("Error:", e.stack || e);
      return Response.json({ error: String(e.message || e) }, { status: 500 });
    }
  },

  async scheduled(evento, env, ctx) {
    ctx.waitUntil(tareasProgramadas(env));
  },
};

async function rutear(req, env, ctx) {
  const url = new URL(req.url);
  const ruta = url.pathname;

  if (ruta === "/telegram" && req.method === "POST") return webhookTelegram(req, env, ctx);

  // imagen pública de una propuesta: la usan Instagram, Telegram y el panel
  const img = ruta.match(/^\/img\/([\w-]+)\.jpg$/);
  if (img) {
    const datos = await env.ARCHIVOS.get("img:" + img[1], "arrayBuffer");
    if (!datos) return new Response("no", { status: 404 });
    return new Response(datos, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  }

  if (ruta === "/" || ruta === "/panel") {
    return new Response(PANEL, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (ruta.startsWith("/api/agente/")) {
    if (req.headers.get("X-Clave") !== (await claveAgente(env))) return new Response("no", { status: 403 });
    return apiAgente(req, env, ctx, ruta.slice("/api/agente/".length), url);
  }

  if (ruta === "/api/panel/codigo" && req.method === "POST") return enviarCodigo(env);
  if (ruta === "/api/panel/login" && req.method === "POST") return login(req, env);
  if (ruta.startsWith("/api/panel/")) {
    if (!(await sesionValida(req, env))) return Response.json({ error: "sin sesión" }, { status: 401 });
    return apiPanel(req, env, ctx, ruta.slice("/api/panel/".length), url);
  }

  return new Response("no", { status: 404 });
}

// ---------------------------------------------------------------- Telegram

async function webhookTelegram(req, env, ctx) {
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await claveAgente(env))) {
    return new Response("no", { status: 403 });
  }
  const u = await req.json();
  const chat = String((u.callback_query ? u.callback_query.message : u.message)?.chat?.id ?? "");
  if (chat !== env.TELEGRAM_CHAT_ID) return new Response("ok");

  if (u.callback_query) {
    const cb = u.callback_query;
    const [accion, id] = cb.data.split(":");
    const textos = { ok: "✅ Publicando...", otra: "🔄 Generando otra...", no: "🗑️ Descartado" };
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: textos[accion] || "Recibido" });
    ctx.waitUntil(accionPropuesta(env, id, accion === "ok" ? "aprobar" : accion === "otra" ? "otra" : "descartar"));
    return new Response("ok");
  }

  const texto = (u.message?.text || "").trim();
  if (!texto) return new Response("ok");
  ctx.waitUntil(comandoTelegram(env, texto, u.message));
  return new Response("ok");
}

async function comandoTelegram(env, texto, mensaje) {
  const [cmd, ...resto] = texto.split(/\s+/);
  const base = cmd.split("@")[0].toLowerCase();

  if (base === "/start") return avisar(env, "Hola! Tu chat_id es " + mensaje.chat.id + ". Panel: " + env.URL_PUBLICA + "/panel");
  if (base === "/panel") return avisar(env, "Panel: " + env.URL_PUBLICA + "/panel");

  if (base === "/clientes") {
    const { results } = await env.DB.prepare("SELECT id, nombre, activo FROM clientes ORDER BY creado").all();
    return avisar(env, "Clientes:\n" + results.map((c) => `${c.activo ? "•" : "◦"} ${c.id} — ${c.nombre}`).join("\n") +
      "\n\nPara pedir un post de otro cliente: /nuevo @cliente tema");
  }

  if (base === "/nuevo") {
    let cliente = env.CLIENTE_DEFAULT;
    if (resto[0]?.startsWith("@")) cliente = resto.shift().slice(1).toLowerCase();
    const c = await env.DB.prepare("SELECT id, nombre FROM clientes WHERE id = ?").bind(cliente).first();
    if (!c) return avisar(env, `No encontré el cliente "${cliente}". Mirá la lista con /clientes`);
    const pedido = resto.join(" ").trim();
    await avisar(env, `✨ Generando un post para ${c.nombre}` + (pedido ? ` sobre: ${pedido}` : "") + "... (1 o 2 minutos)");
    return despacharGenerar(env, c.id, pedido, "");
  }

  // texto suelto: reemplaza el caption de la propuesta a la que respondés (o la última pendiente)
  let p = null;
  if (mensaje.reply_to_message) {
    const mid = mensaje.reply_to_message.message_id;
    p = await env.DB.prepare("SELECT * FROM propuestas WHERE tg_message_id = ? OR json_extract(datos, '$.tg_foto_id') = ?")
      .bind(mid, mid).first();
  }
  if (!p) p = await env.DB.prepare("SELECT * FROM propuestas WHERE estado = 'pendiente' ORDER BY creado DESC LIMIT 1").first();
  if (!p) return avisar(env, "No hay posts pendientes. Mandá /nuevo para generar uno.");
  const datos = JSON.parse(p.datos);
  datos.caption = texto;
  datos.hashtags = "";
  await env.DB.prepare("UPDATE propuestas SET datos = ?, actualizado = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(datos), p.id).run();
  return enviarVistaPrevia(env, p.id);
}

async function enviarVistaPrevia(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const datos = JSON.parse(p.datos);
  const foto = await tg(env, "sendPhoto", {
    chat_id: env.TELEGRAM_CHAT_ID,
    photo: `${env.URL_PUBLICA}/img/${id}.jpg?v=${Date.now()}`,
    caption: `📝 ${p.cliente_nombre}: ${p.titulo}`,
  });
  const botones = { inline_keyboard: [[
    { text: "✅ Publicar", callback_data: "ok:" + id },
    { text: "🔄 Otra", callback_data: "otra:" + id },
    { text: "❌ Descartar", callback_data: "no:" + id },
  ]] };
  const texto = textoFinal(datos) + "\n\n— Respondé a este mensaje con texto para reemplazar el caption.";
  const msg = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: texto.slice(0, 4096), reply_markup: botones });
  datos.tg_foto_id = foto?.result?.message_id;
  await env.DB.prepare("UPDATE propuestas SET tg_message_id = ?, datos = ? WHERE id = ?")
    .bind(msg?.result?.message_id ?? null, JSON.stringify(datos), id).run();
}

// ---------------------------------------------------------------- propuestas

async function accionPropuesta(env, id, accion, cambios = null) {
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  if (!p) return { error: "no existe" };
  if (!["pendiente", "error"].includes(p.estado) && accion !== "otra") {
    await avisar(env, "Ese post ya no está pendiente (" + p.estado + ").");
    return { error: "ya no está pendiente" };
  }
  const datos = JSON.parse(p.datos);
  if (cambios) {
    if (cambios.caption !== undefined) datos.caption = cambios.caption;
    if (cambios.hashtags !== undefined) datos.hashtags = cambios.hashtags;
    await env.DB.prepare("UPDATE propuestas SET datos = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(datos), id).run();
  }

  if (accion === "aprobar") {
    await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    await registrar(env, p.cliente_id, "aprobada", p.titulo);
    return publicar(env, id);
  }
  if (accion === "descartar") {
    await env.DB.prepare("UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    return { ok: true };
  }
  if (accion === "otra") {
    if (p.estado === "pendiente") {
      await env.DB.prepare("UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    }
    await despacharGenerar(env, p.cliente_id, datos.pedido || "", datos.producto || "");
    return { ok: true };
  }
  return { error: "acción desconocida" };
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
    if (!c.ig_user_id || !c.ig_token) throw new Error("el cliente no tiene Instagram configurado");
    const token = await descifrar(env, c.ig_token);
    if (!resultado.contenedor) {
      const r = await igPost(`${IG_API}/${c.ig_user_id}/media`, {
        image_url: `${env.URL_PUBLICA}/img/${id}.jpg`, caption: textoFinal(datos).slice(0, 2200), access_token: token,
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
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, "publicada", p.titulo + " " + resultado.enlace);
    await avisar(env, `🚀 ¡Publicado en ${c.nombre}! ${resultado.enlace}`);
    return { ok: true, enlace: resultado.enlace };
  } catch (e) {
    resultado.error = String(e.message || e);
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, "error", resultado.error);
    await avisar(env, `⚠️ No se pudo publicar en ${c.nombre}: ${resultado.error}\nPodés reintentar desde el panel.`);
    return { error: resultado.error };
  }
}

function guardarResultado(env, id, resultado) {
  return env.DB.prepare("UPDATE propuestas SET resultado = ? WHERE id = ?").bind(JSON.stringify(resultado), id).run();
}

function textoFinal(datos) {
  return `${(datos.caption || "").trim()}\n\n${(datos.hashtags || "").trim()}`.trim();
}

// ---------------------------------------------------------------- API para el generador (GitHub Actions)

async function apiAgente(req, env, ctx, ruta, url) {
  if (ruta === "trabajo") {
    const id = url.searchParams.get("cliente");
    const c = await env.DB.prepare("SELECT id, nombre, marca, calendario, zona FROM clientes WHERE id = ?").bind(id).first();
    if (!c) return Response.json({ error: "no existe el cliente" }, { status: 404 });
    const fotos = await env.DB.prepare("SELECT id, producto, nombre FROM fotos WHERE cliente_id = ? ORDER BY nombre").bind(id).all();
    const historial = await env.DB.prepare(
      "SELECT titulo, json_extract(datos, '$.foto_id') AS foto_id, json_extract(datos, '$.producto') AS producto, actualizado " +
      "FROM propuestas WHERE cliente_id = ? AND estado = 'publicada' ORDER BY actualizado"
    ).bind(id).all();
    return Response.json({ cliente: c, fotos: fotos.results, historial: historial.results });
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
    const id = `${c.id}-${Date.now().toString(36)}`;
    await env.ARCHIVOS.put("img:" + id, base64ABytes(b.imagen_b64));
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'post', ?, ?)")
      .bind(id, c.id, b.titulo, JSON.stringify(b.datos)).run();
    await registrar(env, c.id, "propuesta", b.titulo);
    if (c.auto_publicar) {
      await avisar(env, `🤖 ${c.nombre} en modo automático: publicando "${b.titulo}"`);
      await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ?").bind(id).run();
      ctx.waitUntil(publicar(env, id));
    } else {
      await enviarVistaPrevia(env, id);
    }
    return Response.json({ ok: true, id });
  }

  if (ruta === "aviso" && req.method === "POST") {
    const b = await req.json();
    await avisar(env, String(b.texto).slice(0, 4000));
    return Response.json({ ok: true });
  }

  return new Response("no", { status: 404 });
}

// ---------------------------------------------------------------- API del panel

async function apiPanel(req, env, ctx, ruta, url) {
  const metodo = req.method;
  const cuerpo = async () => (metodo === "GET" ? {} : await req.json());

  if (ruta === "salir") {
    const token = cookie(req, "sesion");
    if (token) await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(token).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": "sesion=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" } });
  }

  if (ruta === "resumen") {
    const clientes = await env.DB.prepare(
      "SELECT c.id, c.nombre, c.activo, c.auto_publicar, c.hora_post, c.ig_user_id IS NOT NULL AND c.ig_token IS NOT NULL AS ig_ok, " +
      "(SELECT COUNT(*) FROM propuestas p WHERE p.cliente_id = c.id AND p.estado = 'pendiente') AS pendientes, " +
      "(SELECT COUNT(*) FROM propuestas p WHERE p.cliente_id = c.id AND p.estado = 'publicada') AS publicadas " +
      "FROM clientes c ORDER BY c.creado"
    ).all();
    return Response.json({ clientes: clientes.results, url: env.URL_PUBLICA });
  }

  if (ruta === "propuestas" && metodo === "GET") {
    const estado = url.searchParams.get("estado") || "pendiente";
    const cliente = url.searchParams.get("cliente") || "";
    const { results } = await env.DB.prepare(
      "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id " +
      "WHERE (? = 'todas' OR p.estado = ?) AND (? = '' OR p.cliente_id = ?) ORDER BY p.creado DESC LIMIT 60"
    ).bind(estado, estado, cliente, cliente).all();
    return Response.json(results.map((p) => ({ ...p, datos: JSON.parse(p.datos), resultado: JSON.parse(p.resultado || "{}") })));
  }

  const accion = ruta.match(/^propuestas\/([\w-]+)\/(aprobar|descartar|otra|reintentar)$/);
  if (accion && metodo === "POST") {
    const b = await cuerpo();
    if (accion[2] === "reintentar") {
      await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ? AND estado = 'error'").bind(accion[1]).run();
      return Response.json(await publicar(env, accion[1]));
    }
    return Response.json(await accionPropuesta(env, accion[1], accion[2], b));
  }

  if (ruta === "generar" && metodo === "POST") {
    const b = await cuerpo();
    await despacharGenerar(env, b.cliente, b.pedido || "", "");
    return Response.json({ ok: true });
  }

  if (ruta === "clientes" && metodo === "POST") {
    const b = await cuerpo();
    const id = String(b.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!id || !b.nombre) return Response.json({ error: "faltan id o nombre" }, { status: 400 });
    await env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, ?)").bind(id, b.nombre).run();
    return Response.json({ ok: true, id });
  }

  const cli = ruta.match(/^clientes\/([\w-]+)$/);
  if (cli && metodo === "GET") {
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(cli[1]).first();
    if (!c) return Response.json({ error: "no existe" }, { status: 404 });
    c.ig_token = c.ig_token ? "(guardado)" : "";
    return Response.json(c);
  }
  if (cli && metodo === "PUT") {
    const b = await cuerpo();
    const campos = ["nombre", "marca", "calendario", "hora_post", "zona", "auto_publicar", "activo", "ig_user_id"];
    for (const campo of campos) {
      if (b[campo] === undefined) continue;
      if (campo === "calendario") JSON.parse(b[campo]); // que sea JSON válido antes de guardarlo
      await env.DB.prepare(`UPDATE clientes SET ${campo} = ? WHERE id = ?`).bind(b[campo], cli[1]).run();
    }
    if (b.ig_token) {
      await env.DB.prepare("UPDATE clientes SET ig_token = ?, ig_token_renovado = datetime('now') WHERE id = ?")
        .bind(await cifrar(env, b.ig_token.trim()), cli[1]).run();
    }
    return Response.json({ ok: true });
  }

  if (ruta === "fotos" && metodo === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM fotos WHERE cliente_id = ? ORDER BY producto, nombre")
      .bind(url.searchParams.get("cliente")).all();
    return Response.json(results);
  }
  if (ruta === "fotos" && metodo === "POST") {
    const form = await req.formData();
    const archivo = form.get("archivo");
    const id = crypto.randomUUID().slice(0, 12);
    await env.ARCHIVOS.put("foto:" + id, await archivo.arrayBuffer());
    await env.DB.prepare("INSERT INTO fotos (id, cliente_id, producto, nombre, tipo) VALUES (?, ?, ?, ?, ?)")
      .bind(id, form.get("cliente"), String(form.get("producto") || "").trim().toLowerCase(), archivo.name, archivo.type || "image/png").run();
    return Response.json({ ok: true, id });
  }
  const fot = ruta.match(/^fotos\/([\w-]+)$/);
  if (fot && metodo === "GET") {
    const f = await env.DB.prepare("SELECT tipo FROM fotos WHERE id = ?").bind(fot[1]).first();
    const datos = await env.ARCHIVOS.get("foto:" + fot[1], "arrayBuffer");
    if (!f || !datos) return new Response("no", { status: 404 });
    return new Response(datos, { headers: { "Content-Type": f.tipo, "Cache-Control": "private, max-age=86400" } });
  }
  if (fot && metodo === "DELETE") {
    await env.DB.prepare("DELETE FROM fotos WHERE id = ?").bind(fot[1]).run();
    await env.ARCHIVOS.delete("foto:" + fot[1]);
    return Response.json({ ok: true });
  }

  if (ruta === "eventos") {
    const { results } = await env.DB.prepare("SELECT * FROM eventos ORDER BY id DESC LIMIT 100").all();
    return Response.json(results);
  }

  return Response.json({ error: "no existe" }, { status: 404 });
}

// ---------------------------------------------------------------- login del panel

async function enviarCodigo(env) {
  const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare("DELETE FROM codigos").run();
  await env.DB.prepare("INSERT INTO codigos (codigo, vence) VALUES (?, datetime('now', '+10 minutes'))").bind(codigo).run();
  await avisar(env, `🔐 Código para entrar al panel: ${codigo}\n(vence en 10 minutos; si no lo pediste vos, ignoralo)`);
  return Response.json({ ok: true });
}

async function login(req, env) {
  const { codigo } = await req.json();
  const ok = await env.DB.prepare("SELECT 1 FROM codigos WHERE codigo = ? AND vence > datetime('now')").bind(String(codigo || "")).first();
  if (!ok) return Response.json({ error: "código incorrecto o vencido" }, { status: 401 });
  await env.DB.prepare("DELETE FROM codigos").run();
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sesiones (token, vence) VALUES (?, datetime('now', '+30 days'))").bind(token).run();
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": `sesion=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` },
  });
}

async function sesionValida(req, env) {
  const token = cookie(req, "sesion");
  if (!token) return false;
  return !!(await env.DB.prepare("SELECT 1 FROM sesiones WHERE token = ? AND vence > datetime('now')").bind(token).first());
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

  // 2. publicaciones que quedaron esperando a Instagram, o trabadas
  await env.DB.prepare(
    "UPDATE propuestas SET estado = 'aprobada' WHERE estado = 'publicando' AND actualizado < datetime('now', '-15 minutes')"
  ).run();
  const { results: aprobadas } = await env.DB.prepare("SELECT id FROM propuestas WHERE estado = 'aprobada'").all();
  for (const p of aprobadas) await publicar(env, p.id);

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
      await avisar(env, `⚠️ No pude renovar el token de Instagram de ${c.nombre}: ${e.message}`);
    }
  }

  await env.DB.prepare("DELETE FROM sesiones WHERE vence < datetime('now')").run();
}

function horaLocal(zona) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

// ---------------------------------------------------------------- GitHub (generador)

async function despacharGenerar(env, cliente, pedido, producto) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/generar.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "kreatit-hub" },
    body: JSON.stringify({ ref: "main", inputs: { cliente, pedido, producto } }),
  });
  if (!r.ok) {
    const error = `GitHub no aceptó la generación (${r.status}): ${(await r.text()).slice(0, 300)}`;
    await registrar(env, cliente, "error", error);
    await avisar(env, "⚠️ " + error);
  }
}

// ---------------------------------------------------------------- utilidades

async function tg(env, metodo, datos) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos),
  });
  const j = await r.json();
  if (!j.ok) console.log(`Telegram ${metodo}:`, JSON.stringify(j));
  return j;
}

function avisar(env, texto) {
  return tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: texto });
}

function registrar(env, cliente, tipo, detalle) {
  return env.DB.prepare("INSERT INTO eventos (cliente_id, tipo, detalle) VALUES (?, ?, ?)").bind(cliente, tipo, String(detalle).slice(0, 1000)).run();
}

async function igPost(url, datos) {
  const r = await fetch(url, { method: "POST", body: new URLSearchParams(datos) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || JSON.stringify(j));
  return j;
}

async function igGet(url, params) {
  const r = await fetch(url + "?" + new URLSearchParams(params));
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || JSON.stringify(j));
  return j;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// La clave que comparten Telegram (secret_token), el generador y el hub: sha256 del token del bot.
async function claveAgente(env) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_TOKEN)));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ABytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesABase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Los tokens de los clientes se guardan cifrados (AES-GCM) con CLAVE_CIFRADO.
async function claveCifrado(env) {
  return crypto.subtle.importKey("raw", base64ABytes(env.CLAVE_CIFRADO), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function cifrar(env, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await claveCifrado(env), new TextEncoder().encode(texto)));
  const todo = new Uint8Array(iv.length + datos.length);
  todo.set(iv);
  todo.set(datos, iv.length);
  return "v1:" + bytesABase64(todo);
}

async function descifrar(env, guardado) {
  const todo = base64ABytes(guardado.slice(3));
  const datos = await crypto.subtle.decrypt({ name: "AES-GCM", iv: todo.slice(0, 12) }, await claveCifrado(env), todo.slice(12));
  return new TextDecoder().decode(datos);
}
