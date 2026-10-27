// Vendedor omnicanal: mensajes de Instagram, Facebook Messenger, WhatsApp y el chat de la web del cliente,
// más los formularios web. Cada persona queda como contacto (lead) y Gemini propone la respuesta; según el cliente,
// se aprueba por Telegram/panel o sale sola. La respuesta siempre vuelve por el mismo canal.

import { IG_API, igGet, gemini, registrar, notificar, destinatarios, tg, descifrar, hex } from "./comun.js";
import { contarIntento } from "./seguridad.js";
import { extrasAgenda, agendarSiCorresponde } from "./agenda.js";
import { extrasCobro, cobrarSiCorresponde } from "./cobros.js";

const FB_API = "https://graph.facebook.com/v23.0";
export const CANALES = { instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp", chat: "el chat de la web", web: "el formulario web", email: "email" };
const ICONO_CANAL = { instagram: "📸", messenger: "💬", whatsapp: "🟢", chat: "🌐", web: "📝", email: "✉️" };

// ---------------------------------------------------------------- webhook de Meta (Instagram, Messenger, WhatsApp)

// Meta verifica la URL una vez (GET) y después manda cada evento (POST, firmado con la clave de la app).
export async function webhookMeta(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.IG_VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge"));
    }
    return new Response("no", { status: 403 });
  }
  const cuerpo = await req.text();
  const firma = req.headers.get("X-Hub-Signature-256");
  // Instagram firma con la clave de la app de Instagram; Messenger y WhatsApp, con la de la app de Facebook
  if (!(await firmaValida(env.IG_APP_SECRET, cuerpo, firma)) && !(await firmaValida(env.META_APP_SECRET, cuerpo, firma))) {
    await contarIntento(env, "webhook");
    return new Response("no", { status: 403 });
  }
  const datos = JSON.parse(cuerpo);
  for (const entrada of datos.entry || []) {
    if (datos.object === "whatsapp_business_account") {
      for (const cambio of entrada.changes || []) {
        const v = cambio.value || {};
        for (const m of v.messages || []) {
          const nombre = (v.contacts || []).find((x) => x.wa_id === m.from)?.profile?.name;
          ctx.waitUntil(recibido(env, "whatsapp", { cuenta: v.metadata?.phone_number_id, persona: m.from, nombre, mid: m.id,
            texto: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `(envió ${m.type})` }));
        }
      }
      continue;
    }
    const canal = datos.object === "page" ? "messenger" : "instagram";
    for (const ev of entrada.messaging || []) {
      if (ev.message?.text === undefined && !ev.message?.attachments) continue;
      const eco = !!ev.message.is_echo; // lo mandó la cuenta del cliente (desde la app o desde el hub)
      ctx.waitUntil(recibido(env, canal, {
        cuenta: String(eco ? ev.sender.id : ev.recipient.id), cuentaEntrada: String(entrada.id), eco,
        persona: String(eco ? ev.recipient.id : ev.sender.id), mid: ev.message.mid, texto: ev.message.text ?? "(envió un adjunto)",
      }));
    }
  }
  return new Response("ok");
}

async function firmaValida(secreto, cuerpo, firma) {
  if (!firma || !secreto) return false;
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo))) === firma;
}

const COLUMNA_CUENTA = { instagram: "ig_user_id", messenger: "fb_pagina_id", whatsapp: "wa_phone_id" };

async function recibido(env, canal, m) {
  const col = COLUMNA_CUENTA[canal];
  const c = await env.DB.prepare(`SELECT * FROM clientes WHERE ${col} = ?`).bind(m.cuenta).first()
    || (m.cuentaEntrada && await env.DB.prepare(`SELECT * FROM clientes WHERE ${col} = ?`).bind(m.cuentaEntrada).first());
  if (!c) {
    await registrar(env, null, "error", `mensaje de ${CANALES[canal]} para una cuenta sin cliente (${m.cuenta})`);
    return;
  }
  const contacto = await contactoDe(env, c, canal, m.persona, m.nombre);
  await guardarMensaje(env, c, contacto, m.mid, m.eco ? "saliente" : "entrante", m.texto, !m.eco);
}

// Guarda el mensaje y, si es del cliente final, prepara la respuesta. Si es un eco (respondieron a mano), cancela la propuesta.
async function guardarMensaje(env, c, contacto, mid, direccion, texto, responder) {
  const nuevo = await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, ?, ?)")
    .bind(mid, c.id, contacto.id, direccion, texto).run();
  if (!nuevo.meta.changes) return; // ya lo teníamos (por ejemplo, el eco de algo que mandó el hub)
  await env.DB.prepare("UPDATE contactos SET ultimo_mensaje = datetime('now'), por_responder = ? WHERE id = ?").bind(responder ? 1 : 0, contacto.id).run();
  if (!responder) {
    await env.DB.prepare(
      "UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE tipo = 'mensaje' AND estado = 'pendiente' AND json_extract(datos, '$.contacto_id') = ?"
    ).bind(contacto.id).run();
    return;
  }
  await registrar(env, c.id, "mensaje", `${ICONO_CANAL[contacto.canal]} ${quien(contacto)}: ${texto}`);
  await proponerRespuestaMensaje(env, contacto.id);
}

const quien = (ct) => ct.nombre || (ct.usuario ? "@" + ct.usuario : null) || ct.telefono || "alguien";

async function contactoDe(env, c, canal, persona, nombre = null) {
  const existente = await env.DB.prepare("SELECT * FROM contactos WHERE cliente_id = ? AND canal = ? AND externo_id = ?").bind(c.id, canal, persona).first();
  if (existente) return existente;
  let perfil = { name: nombre };
  try {
    if (canal === "instagram") perfil = await igGet(`${IG_API}/${persona}`, { fields: "username,name", access_token: await descifrar(env, c.ig_token) });
    if (canal === "messenger" && c.fb_token) {
      const p = await (await fetch(`${FB_API}/${persona}?fields=first_name,last_name&access_token=${encodeURIComponent(await descifrar(env, c.fb_token))}`)).json();
      perfil = { name: [p.first_name, p.last_name].filter(Boolean).join(" ") || null };
    }
  } catch (e) {
    console.log("perfil:", e.message);
  }
  const id = "ct-" + hex(crypto.getRandomValues(new Uint8Array(6)));
  await env.DB.prepare("INSERT INTO contactos (id, cliente_id, canal, externo_id, usuario, nombre, telefono) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, c.id, canal, persona, perfil.username || null, perfil.name || null, canal === "whatsapp" ? "+" + persona : null).run();
  const ct = await env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(id).first();
  if (canal !== "chat") await notificar(env, c.id, `🆕 Nuevo contacto en ${c.nombre}: ${quien(ct)} (${CANALES[canal]})`);
  return ct;
}

// ---------------------------------------------------------------- respuesta sugerida

// La toma una sola vez (por_responder 1 → 0); si Gemini falla, la devuelve para que el cron reintente.
export async function proponerRespuestaMensaje(env, contactoId) {
  const tomada = await env.DB.prepare("UPDATE contactos SET por_responder = 0 WHERE id = ? AND por_responder = 1").bind(contactoId).run();
  if (!tomada.meta.changes) return;
  const ct = await env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(contactoId).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(ct.cliente_id).first();
  const { results: historial } = await env.DB.prepare(
    "SELECT direccion, texto FROM (SELECT * FROM mensajes WHERE contacto_id = ? ORDER BY fecha DESC LIMIT 14) ORDER BY fecha"
  ).bind(ct.id).all();
  const ultimos = [];
  for (let i = historial.length - 1; i >= 0 && historial[i].direccion === "entrante"; i--) ultimos.unshift(historial[i].texto);
  const agenda = await extrasAgenda(env, c), cobro = extrasCobro(c);
  const extras = { texto: agenda.texto + cobro.texto, claves: agenda.claves + cobro.claves };

  let r;
  try {
    r = await gemini(env, `${c.marca}

---
Sos quien atiende los mensajes de ${CANALES[ct.canal]} de ${c.nombre}: respondés rápido, con calidez, y tu objetivo es
ayudar y llevar a la persona al siguiente paso de compra (lo que la marca pida: descargar la app, pedir presupuesto,
reservar, comprar, agendar una demo...).
${extras.texto}
Conversación con ${quien(ct)} (lo más viejo arriba):
${historial.map((m) => (m.direccion === "entrante" ? "Cliente: " : "Nosotros: ") + m.texto).join("\n")}

Respondé SOLO con un JSON con estas claves:
- "respuesta": el próximo mensaje para mandarle (corto, como un chat: 1 a 4 frases, sin markdown ni hashtags)
- "etapa": "conversando" | "interesado" | "cliente" | "perdido"
- "interes": "alto" | "medio" | "bajo"
- "resumen": qué busca esta persona, en una línea
- "nombre", "telefono", "email": si los dio en la conversación (si no, "")
- "urgente": true si es una queja, un problema serio o pide hablar con una persona${extras.claves}

Reglas: usá solo la información de la marca; si no sabés algo (precios, plazos, stock), no lo inventes: decí que lo
consultás o pedí un dato para avanzar. Hacé como mucho una pregunta por mensaje. Si pide hablar con una persona,
decile que en breve lo contacta alguien del equipo.`);
  } catch (e) {
    await env.DB.prepare("UPDATE contactos SET por_responder = 1 WHERE id = ?").bind(ct.id).run();
    console.log("Gemini mensajes:", e.message);
    return;
  }

  await env.DB.prepare(
    "UPDATE contactos SET etapa = CASE WHEN etapa = 'cliente' THEN etapa ELSE ? END, interes = ?, resumen = ?, " +
    "nombre = COALESCE(NULLIF(?, ''), nombre), telefono = COALESCE(NULLIF(?, ''), telefono), email = COALESCE(NULLIF(?, ''), email) WHERE id = ?"
  ).bind(r.etapa || "conversando", r.interes || null, r.resumen || null, r.nombre || "", r.telefono || "", r.email || "", ct.id).run();

  // una sola propuesta pendiente por contacto: la nueva reemplaza a la anterior
  await env.DB.prepare(
    "UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE tipo = 'mensaje' AND estado = 'pendiente' AND json_extract(datos, '$.contacto_id') = ?"
  ).bind(ct.id).run();
  const id = `${c.id}-m${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
  const datos = {
    contacto_id: ct.id, canal: ct.canal, igsid: ct.externo_id, usuario: ct.usuario || ct.nombre || ct.telefono, entrante: ultimos.join("\n").slice(0, 1500),
    respuesta: r.respuesta || "", interes: r.interes, resumen: r.resumen, urgente: !!r.urgente, agenda: r.agenda || null, cobro: r.cobro || null,
  };
  await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'mensaje', ?, ?)")
    .bind(id, c.id, `Mensaje de ${quien(ct)} (${CANALES[ct.canal]})`, JSON.stringify(datos)).run();

  // el chat de la web siempre contesta solo (la persona está esperando en la página), salvo urgencias
  const automatico = (c.auto_mensajes || ct.canal === "chat") && !r.urgente;
  if (automatico) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada' WHERE id = ?").bind(id).run();
    return ejecutarMensaje(env, id);
  }
  await vistaPreviaMensaje(env, id);
}

// Reintenta las que quedaron sin propuesta (por ejemplo, si Gemini estaba saturado). Hasta 3 por pasada.
export async function proponerPendientesMensajes(env) {
  const { results } = await env.DB.prepare("SELECT id FROM contactos WHERE por_responder = 1 ORDER BY ultimo_mensaje LIMIT 3").all();
  for (const ct of results) await proponerRespuestaMensaje(env, ct.id);
}

const INTERES = { alto: "🔥", medio: "🙂", bajo: "🧊" };

export async function vistaPreviaMensaje(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const d = JSON.parse(p.datos);
  const canal = d.canal || "instagram";
  const texto = `${d.urgente ? "🔴 URGENTE — " : ""}${ICONO_CANAL[canal]} ${p.cliente_nombre} · ${CANALES[canal]}: ${d.usuario || "alguien"} escribió:\n«${d.entrante}»\n` +
    (d.resumen ? `${INTERES[d.interes] || ""} ${d.resumen}\n` : "") +
    (d.agenda ? `📅 Propone agendar: ${d.agenda.inicio} (${d.agenda.motivo || ""})\n` : "") +
    (d.cobro ? `💳 Propone cobrar: $${d.cobro.monto} — ${d.cobro.concepto}\n` : "") +
    `\nRespuesta sugerida:\n${d.respuesta}\n\n— Respondé a este mensaje con otro texto para cambiarla.`;
  const botones = { inline_keyboard: [[
    { text: "✅ Enviar", callback_data: "ok:" + id },
    { text: "🔄 Otra", callback_data: "otra:" + id },
    { text: "❌ Ignorar", callback_data: "no:" + id },
  ]] };
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const m = await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4096), reply_markup: botones });
    if (m?.result?.message_id) {
      await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
    }
  }
}

// ---------------------------------------------------------------- envío por el canal de cada contacto

async function metaPost(url, cuerpo, token) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(cuerpo) });
  const j = await r.json();
  if (!r.ok || j.error) {
    const msg = j.error?.message || JSON.stringify(j);
    throw new Error(/outside of allowed window|24 ?h|re-engage|131047/i.test(msg)
      ? "pasaron más de 24 h desde su último mensaje: la plataforma no deja escribirle hasta que vuelva a escribir" : msg);
  }
  return j;
}

export async function enviarPorCanal(env, c, ct, texto) {
  if (ct.canal === "instagram") {
    return (await metaPost(`${IG_API}/${c.ig_user_id}/messages`, { recipient: { id: ct.externo_id }, message: { text: texto } }, await descifrar(env, c.ig_token))).message_id;
  }
  if (ct.canal === "messenger") {
    if (!c.fb_token) throw new Error("falta conectar la página de Facebook");
    return (await metaPost(`${FB_API}/me/messages`, { recipient: { id: ct.externo_id }, messaging_type: "RESPONSE", message: { text: texto } }, await descifrar(env, c.fb_token))).message_id;
  }
  if (ct.canal === "whatsapp") {
    if (!c.wa_token || !c.wa_phone_id) throw new Error("falta conectar WhatsApp");
    const j = await metaPost(`${FB_API}/${c.wa_phone_id}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to: ct.externo_id, type: "text", text: { body: texto } }, await descifrar(env, c.wa_token));
    return j.messages?.[0]?.id;
  }
  if (ct.canal === "chat") return "chat-" + Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(3))); // lo lee la web al consultar
  throw new Error(`a este contacto (${CANALES[ct.canal] || ct.canal}) respondele por su email o teléfono`);
}

export async function ejecutarMensaje(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está enviando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  const ct = await env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(d.contacto_id).first();
  try {
    await agendarSiCorresponde(env, c, ct, d); // si confirmó un horario, se crea el evento
    d.respuesta = await cobrarSiCorresponde(env, c, ct, d); // si va a pagar, se agrega el link de Mercado Pago
    const mid = await enviarPorCanal(env, c, ct, d.respuesta);
    await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'saliente', ?)")
      .bind(mid || "hub-" + id, c.id, d.contacto_id, d.respuesta).run();
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', datos = ?, resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(d), JSON.stringify({ message_id: mid }), id).run();
    await registrar(env, c.id, "enviado", `${ICONO_CANAL[ct.canal]} a ${quien(ct)}: ${d.respuesta}`);
    return { ok: true };
  } catch (e) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify({ error: String(e.message || e) }), id).run();
    await registrar(env, c.id, "error", `mensaje por ${CANALES[ct.canal]}: ${e.message}`);
    await notificar(env, c.id, `⚠️ No pude enviarle el mensaje a ${quien(ct)} por ${CANALES[ct.canal]} (${c.nombre}): ${e.message}`);
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- chat de la web del cliente

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

// /chat/<cliente>.js (el globito), POST /chat/<cliente>/enviar y GET /chat/<cliente>/mensajes
export async function rutaChat(req, env, ctx, clienteId, accion, url) {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ? AND activo = 1").bind(clienteId).first();
  const cfg = JSON.parse(c?.chat_config || "{}");
  if (!c || !cfg.activo) return new Response(accion === "js" ? "" : "{}", { status: 404, headers: CORS });

  if (accion === "js") return new Response(scriptChat(env, c, cfg), { headers: { ...CORS, "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" } });

  const visitante = String(url.searchParams.get("v") || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
  if (visitante.length < 16) return Response.json({ error: "visitante inválido" }, { status: 400, headers: CORS });

  if (accion === "enviar" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const texto = String(b.texto || "").trim().slice(0, 1000);
    if (!texto) return Response.json({ error: "vacío" }, { status: 400, headers: CORS });
    const limite = `chat:${c.id}:${visitante}:${new Date().toISOString().slice(0, 13)}`; // máx. 30 mensajes por hora por visitante
    const n = Number((await env.ARCHIVOS.get(limite)) || 0);
    if (n >= 30) return Response.json({ error: "demasiados mensajes, probá en un rato" }, { status: 429, headers: CORS });
    await env.ARCHIVOS.put(limite, String(n + 1), { expirationTtl: 3700 });
    const ct = await contactoDe(env, c, "chat", visitante, String(b.nombre || "").slice(0, 80) || null);
    if (n === 0 && !ct.ultimo_mensaje) await notificar(env, c.id, `🌐 Alguien abrió el chat de la web de ${c.nombre}: «${texto.slice(0, 200)}»`);
    ctx.waitUntil(guardarMensaje(env, c, ct, "chatin-" + Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(3))), "entrante", texto, true));
    return Response.json({ ok: true }, { headers: CORS });
  }

  if (accion === "mensajes") {
    const ct = await env.DB.prepare("SELECT id FROM contactos WHERE cliente_id = ? AND canal = 'chat' AND externo_id = ?").bind(c.id, visitante).first();
    if (!ct) return Response.json({ mensajes: [] }, { headers: CORS });
    const { results } = await env.DB.prepare("SELECT direccion, texto, fecha FROM mensajes WHERE contacto_id = ? ORDER BY fecha LIMIT 100").bind(ct.id).all();
    return Response.json({ mensajes: results }, { headers: CORS });
  }
  return new Response("no", { status: 404, headers: CORS });
}

function scriptChat(env, c, cfg) {
  const base = `${env.URL_PUBLICA}/chat/${c.id}`;
  const color = /^#[0-9a-f]{3,8}$/i.test(cfg.color || "") ? cfg.color : "#4b3fb0";
  return `(() => {
  if (window.__chatKreatit) return; window.__chatKreatit = 1;
  const base = ${JSON.stringify(base)}, saludo = ${JSON.stringify(cfg.saludo || "¡Hola! ¿En qué te puedo ayudar?")}, nombre = ${JSON.stringify(c.nombre)};
  let v; try { v = localStorage.getItem("chatk-v"); } catch (e) {}
  if (!v) { v = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join(""); try { localStorage.setItem("chatk-v", v); } catch (e) {} }
  const css = "#chk-b{position:fixed;right:18px;bottom:18px;width:58px;height:58px;border-radius:50%;background:${color};color:#fff;border:0;font-size:26px;cursor:pointer;box-shadow:0 6px 20px #0004;z-index:2147483000}" +
    "#chk-w{position:fixed;right:18px;bottom:88px;width:min(360px,calc(100vw - 36px));height:min(500px,calc(100vh - 120px));background:#fff;color:#222;border-radius:14px;box-shadow:0 10px 40px #0005;display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font:14px/1.4 system-ui,sans-serif}" +
    "#chk-h{background:${color};color:#fff;padding:12px 14px;font-weight:600}#chk-m{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px;background:#f6f6f9}" +
    ".chk-x{max-width:80%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}.chk-in{align-self:flex-end;background:${color};color:#fff}.chk-out{align-self:flex-start;background:#fff;border:1px solid #e3e3ea}" +
    "#chk-f{display:flex;border-top:1px solid #e3e3ea}#chk-t{flex:1;border:0;padding:12px;font:inherit;outline:none}#chk-s{border:0;background:none;color:${color};font-weight:700;padding:0 14px;cursor:pointer}";
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const b = document.createElement("button"); b.id = "chk-b"; b.setAttribute("aria-label", "Abrir chat"); b.textContent = "💬";
  const w = document.createElement("div"); w.id = "chk-w"; w.setAttribute("role", "dialog");
  w.innerHTML = '<div id="chk-h"></div><div id="chk-m" aria-live="polite"></div><form id="chk-f"><input id="chk-t" placeholder="Escribí tu mensaje..." autocomplete="off" maxlength="1000"><button id="chk-s">Enviar</button></form>';
  document.body.append(b, w);
  w.querySelector("#chk-h").textContent = nombre;
  const caja = w.querySelector("#chk-m"); let vistos = -1, reloj = null;
  const pintar = (lista) => { caja.innerHTML = ""; [{ direccion: "saliente", texto: saludo }, ...lista].forEach((m) => { const d = document.createElement("div"); d.className = "chk-x " + (m.direccion === "entrante" ? "chk-in" : "chk-out"); d.textContent = m.texto; caja.appendChild(d); }); caja.scrollTop = caja.scrollHeight; };
  const traer = async () => { try { const r = await fetch(base + "/mensajes?v=" + v); const j = await r.json(); if ((j.mensajes || []).length !== vistos) { vistos = j.mensajes.length; pintar(j.mensajes); } } catch (e) {} };
  b.onclick = () => { const abierto = w.style.display === "flex"; w.style.display = abierto ? "none" : "flex"; clearInterval(reloj); if (!abierto) { traer(); reloj = setInterval(traer, 4000); w.querySelector("#chk-t").focus(); } };
  w.querySelector("#chk-f").onsubmit = async (e) => { e.preventDefault(); const t = w.querySelector("#chk-t"); const texto = t.value.trim(); if (!texto) return; t.value = "";
    const d = document.createElement("div"); d.className = "chk-x chk-in"; d.textContent = texto; caja.appendChild(d); caja.scrollTop = caja.scrollHeight;
    try { await fetch(base + "/enviar?v=" + v, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }) }); } catch (e) {} setTimeout(traer, 1500); };
})();`;
}

// ---------------------------------------------------------------- formulario web

// POST /lead/<cliente> desde la web del cliente (formulario o fetch). Campos: nombre, email, telefono, mensaje.
// "website" es una trampa para bots: si viene completo, se ignora.
export async function leadWeb(req, env, clienteId) {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("no", { status: 405, headers: CORS });
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ? AND activo = 1").bind(clienteId).first();
  if (!c) return Response.json({ error: "no existe" }, { status: 404, headers: CORS });
  const tipo = req.headers.get("Content-Type") || "";
  const f = tipo.includes("json") ? await req.json() : Object.fromEntries(await req.formData());
  const campo = (k) => String(f[k] || "").trim().slice(0, 500);
  if (campo("website")) return Response.json({ ok: true }, { headers: CORS });
  if (!campo("email") && !campo("telefono")) return Response.json({ error: "dejá un email o un teléfono" }, { status: 400, headers: CORS });

  const id = "ct-" + hex(crypto.getRandomValues(new Uint8Array(6)));
  await env.DB.prepare(
    "INSERT INTO contactos (id, cliente_id, canal, externo_id, nombre, email, telefono, ultimo_mensaje) VALUES (?, ?, 'web', ?, ?, ?, ?, datetime('now'))"
  ).bind(id, c.id, id, campo("nombre") || null, campo("email") || null, campo("telefono") || null).run();
  if (campo("mensaje")) {
    await env.DB.prepare("INSERT INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'entrante', ?)")
      .bind("web-" + id, c.id, id, campo("mensaje")).run();
  }
  await registrar(env, c.id, "lead", `web: ${campo("nombre")} ${campo("email")} ${campo("telefono")}`);
  await notificar(env, c.id, `🆕 Lead desde la web de ${c.nombre}:\n${campo("nombre") || "(sin nombre)"}\n📧 ${campo("email") || "-"}  📞 ${campo("telefono") || "-"}\n${campo("mensaje")}`);
  if (!tipo.includes("json")) { // formulario HTML común: página de gracias
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>¡Gracias!</title>
      <body style="font:17px system-ui;text-align:center;padding:15vh 16px"><h1>¡Gracias!</h1><p>Recibimos tus datos. ${c.nombre.replace(/[&<>"']/g, "")} te va a contactar pronto.</p>
      <p><a href="javascript:history.back()">Volver</a></p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return Response.json({ ok: true }, { headers: CORS });
}
