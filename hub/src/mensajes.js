// Leads y respuesta de ventas: mensajes directos de Instagram (webhook) y formularios web.
//
// Cada persona que escribe queda como contacto (lead). Gemini lee la conversación y propone la respuesta;
// según el cliente, se aprueba por Telegram/panel o se envía sola.

import { IG_API, igGet, gemini, registrar, notificar, destinatarios, tg, descifrar, hex } from "./comun.js";

// ---------------------------------------------------------------- webhook de Instagram

// Meta verifica la URL una vez (GET) y después manda cada mensaje (POST, firmado con la clave de la app).
export async function webhookInstagram(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.IG_VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge"));
    }
    return new Response("no", { status: 403 });
  }

  const cuerpo = await req.text();
  if (!(await firmaValida(env, cuerpo, req.headers.get("X-Hub-Signature-256")))) return new Response("no", { status: 403 });
  const datos = JSON.parse(cuerpo);
  for (const entrada of datos.entry || []) {
    for (const ev of entrada.messaging || []) {
      if (ev.message?.text !== undefined || ev.message?.attachments) ctx.waitUntil(mensajeRecibido(env, ctx, entrada.id, ev));
    }
  }
  return new Response("ok");
}

async function firmaValida(env, cuerpo, firma) {
  if (!firma || !env.IG_APP_SECRET) return false;
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.IG_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const esperada = "sha256=" + hex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo)));
  return esperada === firma;
}

async function mensajeRecibido(env, ctx, cuentaId, ev) {
  const eco = !!ev.message.is_echo; // lo mandó la cuenta del cliente (desde la app o desde el hub)
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE ig_user_id = ?").bind(String(eco ? ev.sender.id : ev.recipient.id)).first()
    || await env.DB.prepare("SELECT * FROM clientes WHERE ig_user_id = ?").bind(String(cuentaId)).first();
  if (!c) {
    await registrar(env, null, "error", `mensaje de Instagram para una cuenta sin cliente (${cuentaId})`);
    return;
  }
  const persona = String(eco ? ev.recipient.id : ev.sender.id);
  const texto = ev.message.text ?? "(envió un adjunto)";
  const contacto = await contactoInstagram(env, c, persona);

  const nuevo = await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, ?, ?)")
    .bind(ev.message.mid, c.id, contacto.id, eco ? "saliente" : "entrante", texto).run();
  if (!nuevo.meta.changes) return; // ya lo teníamos (por ejemplo, el eco de algo que mandó el hub)
  await env.DB.prepare("UPDATE contactos SET ultimo_mensaje = datetime('now'), por_responder = ? WHERE id = ?")
    .bind(eco ? 0 : 1, contacto.id).run();

  if (eco) { // alguien respondió a mano desde Instagram: se cancela lo que el hub tenía propuesto
    await env.DB.prepare(
      "UPDATE propuestas SET estado = 'descartada', actualizado = datetime('now') WHERE tipo = 'mensaje' AND estado = 'pendiente' AND json_extract(datos, '$.contacto_id') = ?"
    ).bind(contacto.id).run();
    return;
  }
  await registrar(env, c.id, "mensaje", `@${contacto.usuario || persona}: ${texto}`);
  await proponerRespuestaMensaje(env, contacto.id);
}

async function contactoInstagram(env, c, persona) {
  let contacto = await env.DB.prepare("SELECT * FROM contactos WHERE cliente_id = ? AND canal = 'instagram' AND externo_id = ?").bind(c.id, persona).first();
  if (contacto) return contacto;
  let perfil = {};
  try {
    perfil = await igGet(`${IG_API}/${persona}`, { fields: "username,name", access_token: await descifrar(env, c.ig_token) });
  } catch (e) {
    console.log("perfil IG:", e.message);
  }
  const id = "ct-" + hex(crypto.getRandomValues(new Uint8Array(6)));
  await env.DB.prepare("INSERT INTO contactos (id, cliente_id, canal, externo_id, usuario, nombre) VALUES (?, ?, 'instagram', ?, ?, ?)")
    .bind(id, c.id, persona, perfil.username || null, perfil.name || null).run();
  await notificar(env, c.id, `🆕 Nuevo contacto en ${c.nombre}: @${perfil.username || persona} (Instagram)`);
  return env.DB.prepare("SELECT * FROM contactos WHERE id = ?").bind(id).first();
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

  let r;
  try {
    r = await gemini(env, `${c.marca}

---
Sos quien atiende los mensajes directos de Instagram de ${c.nombre}: respondés rápido, con calidez, y tu objetivo es
ayudar y llevar a la persona al siguiente paso de compra (lo que la marca pida: descargar la app, pedir presupuesto,
reservar, comprar, pasar a WhatsApp...).

Conversación con @${ct.usuario || "cliente"} (lo más viejo arriba):
${historial.map((m) => (m.direccion === "entrante" ? "Cliente: " : "Nosotros: ") + m.texto).join("\n")}

Respondé SOLO con un JSON con estas claves:
- "respuesta": el próximo mensaje para mandarle (corto, como un chat: 1 a 4 frases, sin markdown ni hashtags)
- "etapa": "conversando" | "interesado" | "cliente" | "perdido"
- "interes": "alto" | "medio" | "bajo"
- "resumen": qué busca esta persona, en una línea
- "nombre", "telefono", "email": si los dio en la conversación (si no, "")
- "urgente": true si es una queja, un problema serio o pide hablar con una persona

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
    contacto_id: ct.id, igsid: ct.externo_id, usuario: ct.usuario, entrante: ultimos.join("\n").slice(0, 1500),
    respuesta: r.respuesta || "", interes: r.interes, resumen: r.resumen, urgente: !!r.urgente,
  };
  await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'mensaje', ?, ?)")
    .bind(id, c.id, `Mensaje de @${ct.usuario || ct.externo_id}`, JSON.stringify(datos)).run();

  if (c.auto_mensajes && !r.urgente) {
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
  const texto = `${d.urgente ? "🔴 URGENTE — " : ""}📩 ${p.cliente_nombre}: @${d.usuario || "alguien"} escribió:\n«${d.entrante}»\n` +
    (d.resumen ? `${INTERES[d.interes] || ""} ${d.resumen}\n` : "") +
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

// ---------------------------------------------------------------- envío

export async function enviarMensajeIG(env, c, igsid, texto) {
  const r = await fetch(`${IG_API}/${c.ig_user_id}/messages?access_token=${encodeURIComponent(await descifrar(env, c.ig_token))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } }),
  });
  const j = await r.json();
  if (!r.ok || j.error) {
    const msg = j.error?.message || JSON.stringify(j);
    throw new Error(/outside of allowed window|24/.test(msg) ? "pasaron más de 24 h desde su último mensaje; Instagram no deja escribirle hasta que vuelva a escribir" : msg);
  }
  return j.message_id;
}

export async function ejecutarMensaje(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está enviando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  try {
    const mid = await enviarMensajeIG(env, c, d.igsid, d.respuesta);
    await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'saliente', ?)")
      .bind(mid || "hub-" + id, c.id, d.contacto_id, d.respuesta).run();
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify({ message_id: mid }), id).run();
    await registrar(env, c.id, "enviado", `a @${d.usuario}: ${d.respuesta}`);
    return { ok: true };
  } catch (e) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify({ error: String(e.message || e) }), id).run();
    await registrar(env, c.id, "error", "mensaje directo: " + e.message);
    await notificar(env, c.id, `⚠️ No pude enviarle el mensaje a @${d.usuario} (${c.nombre}): ${e.message}`);
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- formulario web

// POST /lead/<cliente> desde la web del cliente (formulario o fetch). Campos: nombre, email, telefono, mensaje.
// "website" es una trampa para bots: si viene completo, se ignora.
export async function leadWeb(req, env, clienteId) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("no", { status: 405, headers: cors });
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ? AND activo = 1").bind(clienteId).first();
  if (!c) return Response.json({ error: "no existe" }, { status: 404, headers: cors });
  const tipo = req.headers.get("Content-Type") || "";
  const f = tipo.includes("json") ? await req.json() : Object.fromEntries(await req.formData());
  const campo = (k) => String(f[k] || "").trim().slice(0, 500);
  if (campo("website")) return Response.json({ ok: true }, { headers: cors });
  if (!campo("email") && !campo("telefono")) return Response.json({ error: "dejá un email o un teléfono" }, { status: 400, headers: cors });

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
  return Response.json({ ok: true }, { headers: cors });
}
