// Nutrición de leads por email (Brevo). Cada cliente define su secuencia (días + objetivo de cada email);
// Gemini escribe cada email para esa persona; se aprueba o sale solo, según el cliente.
// Se corta cuando el lead pasa a "cliente" o "perdido", o cuando se da de baja con el link del pie.

import { gemini, registrar, destinatarios, tg, hex } from "./comun.js";

const ESPERANDO = "9999-12-31"; // nutricion_proximo mientras un email espera aprobación

const SELECT_LEAD = "SELECT ct.*, c.nombre AS cliente_nombre, c.marca, c.nutricion FROM contactos ct JOIN clientes c ON c.id = ct.cliente_id";
const ACTIVA = "json_extract(c.nutricion, '$.activo') = 1 AND c.activo = 1 AND ct.baja = 0 AND ct.etapa NOT IN ('cliente', 'perdido') " +
  "AND ct.email IS NOT NULL AND ct.email != ''";

// Cron: programa a los leads nuevos con email y prepara hasta 2 emails por pasada.
export async function nutricionPendiente(env) {
  await env.DB.prepare(
    `UPDATE contactos SET nutricion_proximo = datetime('now') WHERE id IN (SELECT ct.id FROM contactos ct JOIN clientes c ON c.id = ct.cliente_id ` +
    `WHERE ${ACTIVA} AND ct.nutricion_paso = 0 AND ct.nutricion_proximo IS NULL)`
  ).run();
  const { results } = await env.DB.prepare(`${SELECT_LEAD} WHERE ${ACTIVA} AND ct.nutricion_proximo <= datetime('now') ORDER BY ct.nutricion_proximo LIMIT 2`).all();
  for (const ct of results) await prepararEmail(env, ct);
}

async function prepararEmail(env, ct) {
  const cfg = JSON.parse(ct.nutricion || "{}");
  const paso = cfg.pasos?.[ct.nutricion_paso];
  if (!paso) { // terminó la secuencia
    await env.DB.prepare("UPDATE contactos SET nutricion_proximo = ? WHERE id = ?").bind(ESPERANDO, ct.id).run();
    return;
  }
  const { results: charla } = await env.DB.prepare(
    "SELECT direccion, texto FROM (SELECT * FROM mensajes WHERE contacto_id = ? ORDER BY fecha DESC LIMIT 10) ORDER BY fecha"
  ).bind(ct.id).all();
  const { results: anteriores } = await env.DB.prepare("SELECT asunto FROM emails WHERE contacto_id = ? AND estado = 'enviado' ORDER BY fecha").bind(ct.id).all();

  let r;
  try {
    r = await gemini(env, `${ct.marca}

---
Escribís el email ${ct.nutricion_paso + 1} de ${cfg.pasos.length} de una secuencia de seguimiento para un lead de ${ct.cliente_nombre}.
Objetivo de este email: ${paso.objetivo}
Lead: ${ct.nombre || "(sin nombre)"} · vino por ${ct.canal} · qué busca: ${ct.resumen || "(no sabemos)"} · etapa: ${ct.etapa}
${charla.length ? "Conversación que tuvo con nosotros:\n" + charla.map((m) => (m.direccion === "entrante" ? "Lead: " : "Nosotros: ") + m.texto).join("\n") : ""}
${anteriores.length ? "Asuntos de los emails que ya recibió: " + anteriores.map((a) => `"${a.asunto}"`).join(", ") : ""}

Respondé SOLO con un JSON: {"asunto": "...", "cuerpo": "..."}
- asunto: máximo 60 caracteres, concreto y honesto (nada de "RE:" falsos ni clickbait).
- cuerpo: texto plano de 80 a 180 palabras, párrafos separados por una línea en blanco, personal (usá su nombre si lo
  tenemos), con un solo llamado a la acción claro, firmado como ${ct.cliente_nombre}. Sin markdown. No inventes precios,
  datos ni casos que no estén en la información de la marca.`);
  } catch (e) {
    console.log("Gemini nutrición:", e.message);
    return; // se reintenta en la próxima pasada
  }

  if (cfg.auto) return enviarEmail(env, ct, r.asunto, r.cuerpo);

  await env.DB.prepare("UPDATE contactos SET nutricion_proximo = ? WHERE id = ?").bind(ESPERANDO, ct.id).run();
  const id = `${ct.cliente_id}-e${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
  const datos = { contacto_id: ct.id, email: ct.email, nombre: ct.nombre, paso: ct.nutricion_paso, total: cfg.pasos.length, objetivo: paso.objetivo, asunto: r.asunto, cuerpo: r.cuerpo };
  await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'email', ?, ?)")
    .bind(id, ct.cliente_id, `Email ${ct.nutricion_paso + 1} para ${ct.nombre || ct.email}`, JSON.stringify(datos)).run();
  await vistaPreviaEmail(env, id);
}

export async function vistaPreviaEmail(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const d = JSON.parse(p.datos);
  const texto = `✉️ ${p.cliente_nombre}: email ${d.paso + 1} de ${d.total} para ${d.nombre || ""} <${d.email}>\n` +
    `Asunto: ${d.asunto}\n\n${d.cuerpo}\n\n— Respondé a este mensaje con otro texto para cambiar el cuerpo.`;
  const botones = { inline_keyboard: [[
    { text: "✅ Enviar", callback_data: "ok:" + id },
    { text: "🔄 Otro", callback_data: "otra:" + id },
    { text: "⏭️ Saltear", callback_data: "no:" + id },
  ]] };
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const m = await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4096), reply_markup: botones });
    if (m?.result?.message_id) {
      await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
    }
  }
}

// Envía el email y programa el siguiente paso de la secuencia.
async function enviarEmail(env, ct, asunto, cuerpo) {
  const cfg = JSON.parse(ct.nutricion || "{}");
  const baja = `${env.URL_PUBLICA}/baja/${ct.id}.${await firmaBaja(env, ct.id)}`;
  const parrafos = cuerpo.trim().split(/\n\s*\n/).map((p) => `<p>${escapar(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#222;max-width:600px">${parrafos}` +
    `<p style="font-size:12px;color:#888;margin-top:32px">Recibís este email porque te contactaste con ${escapar(ct.cliente_nombre)}. ` +
    `<a href="${baja}" style="color:#888">No quiero recibir más emails</a></p></div>`;
  let detalle = "";
  let ok = false;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY || "", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: cfg.remitente_nombre || ct.cliente_nombre, email: cfg.remitente_email },
        to: [{ email: ct.email, ...(ct.nombre ? { name: ct.nombre } : {}) }],
        ...(cfg.responder_a ? { replyTo: { email: cfg.responder_a } } : {}),
        subject: asunto, htmlContent: html, textContent: `${cuerpo}\n\n—\nPara no recibir más emails: ${baja}`,
        headers: { "List-Unsubscribe": `<${baja}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        tags: ["nutricion", ct.cliente_id],
      }),
    });
    const j = await r.json().catch(() => ({}));
    ok = r.ok;
    detalle = ok ? j.messageId || "" : j.message || `Brevo respondió ${r.status}`;
  } catch (e) {
    detalle = String(e.message || e);
  }
  await env.DB.prepare("INSERT INTO emails (id, cliente_id, contacto_id, paso, asunto, cuerpo, estado, detalle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind("em-" + hex(crypto.getRandomValues(new Uint8Array(6))), ct.cliente_id, ct.id, ct.nutricion_paso, asunto, cuerpo, ok ? "enviado" : "error", detalle).run();
  if (!ok) {
    await env.DB.prepare("UPDATE contactos SET nutricion_proximo = datetime('now', '+6 hours') WHERE id = ?").bind(ct.id).run();
    await registrar(env, ct.cliente_id, "error", `email a ${ct.email}: ${detalle}`);
    return { error: detalle };
  }
  await avanzarPaso(env, ct, cfg);
  await registrar(env, ct.cliente_id, "email", `paso ${ct.nutricion_paso + 1} a ${ct.email}: ${asunto}`);
  return { ok: true };
}

async function avanzarPaso(env, ct, cfg) {
  const actual = cfg.pasos?.[ct.nutricion_paso];
  const siguiente = cfg.pasos?.[ct.nutricion_paso + 1];
  const dias = siguiente ? Math.max(1, Number(siguiente.dias) - Number(actual?.dias || 0)) : null;
  await env.DB.prepare("UPDATE contactos SET nutricion_paso = nutricion_paso + 1, nutricion_proximo = ? WHERE id = ?")
    .bind(siguiente ? new Date(Date.now() + dias * 86400000).toISOString().slice(0, 19).replace("T", " ") : ESPERANDO, ct.id).run();
}

// ---------------------------------------------------------------- acciones sobre la propuesta

export async function ejecutarEmail(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está enviando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const d = JSON.parse(p.datos);
  const ct = await env.DB.prepare(`${SELECT_LEAD} WHERE ct.id = ?`).bind(d.contacto_id).first();
  const r = ct.baja ? { error: "el lead se dio de baja" } : await enviarEmail(env, ct, d.asunto, d.cuerpo);
  await env.DB.prepare("UPDATE propuestas SET estado = ?, resultado = ?, actualizado = datetime('now') WHERE id = ?")
    .bind(r.ok ? "publicada" : "error", JSON.stringify(r.ok ? {} : { error: r.error }), id).run();
  return r;
}

// "Saltear": no se manda este email y la secuencia sigue con el próximo.
export async function saltearEmail(env, datos) {
  const ct = await env.DB.prepare(`${SELECT_LEAD} WHERE ct.id = ?`).bind(datos.contacto_id).first();
  if (ct) await avanzarPaso(env, ct, JSON.parse(ct.nutricion || "{}"));
}

// "Otro": se vuelve a escribir este mismo paso en la próxima pasada del cron.
export async function otroEmail(env, datos) {
  await env.DB.prepare("UPDATE contactos SET nutricion_proximo = datetime('now') WHERE id = ?").bind(datos.contacto_id).run();
}

// ---------------------------------------------------------------- baja

async function firmaBaja(env, contactoId) {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CLAVE_CIFRADO), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode("baja:" + contactoId))).slice(0, 24);
}

export async function paginaBaja(req, env, token) {
  const [id, firma] = token.split(".");
  const pagina = (texto) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Baja</title><body style="font:17px system-ui;text-align:center;padding:15vh 16px"><p>${texto}</p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (!id || firma !== (await firmaBaja(env, id))) return pagina("El link no es válido.");
  const ct = await env.DB.prepare("SELECT ct.id, ct.cliente_id, ct.email, c.nombre FROM contactos ct JOIN clientes c ON c.id = ct.cliente_id WHERE ct.id = ?").bind(id).first();
  if (!ct) return pagina("El link no es válido.");
  await env.DB.prepare("UPDATE contactos SET baja = 1 WHERE id = ?").bind(id).run();
  await registrar(env, ct.cliente_id, "baja", `${ct.email} se dio de baja de los emails`);
  return pagina(`Listo: no vas a recibir más emails de ${escapar(ct.nombre)}.`);
}

function escapar(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
