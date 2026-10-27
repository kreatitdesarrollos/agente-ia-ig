// Cobranzas: links de pago de Mercado Pago dentro de la conversación (o desde el panel), aviso cuando pagan
// y recordatorio al equipo si no pagan. El pago se confirma consultando a Mercado Pago (no se confía en el aviso).

import { cifrar, descifrar, hex, registrar, notificar } from "./comun.js";

const MP_API = "https://api.mercadopago.com";

export async function crearCobro(env, c, contactoId, concepto, monto) {
  if (!c.mp_token) throw new Error("falta conectar Mercado Pago (Mi cuenta → Cobros)");
  const id = "cb-" + hex(crypto.getRandomValues(new Uint8Array(6)));
  const r = await fetch(`${MP_API}/checkout/preferences`, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await descifrar(env, c.mp_token)), "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ title: String(concepto).slice(0, 250), quantity: 1, unit_price: Number(monto), currency_id: "ARS" }],
      external_reference: id,
      notification_url: `${env.URL_PUBLICA}/mp/${c.id}`,
      statement_descriptor: c.nombre.slice(0, 22),
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.init_point) throw new Error("Mercado Pago no creó el link: " + (j.message || JSON.stringify(j).slice(0, 200)));
  await env.DB.prepare("INSERT INTO cobros (id, cliente_id, contacto_id, concepto, monto, link, preferencia_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, c.id, contactoId, concepto, Number(monto), j.init_point, j.id).run();
  await registrar(env, c.id, "cobro", `link de $${monto}: ${concepto}`);
  return { id, link: j.init_point };
}

// Para el prompt del Vendedor: solo propone cobrar si hay Mercado Pago conectado.
export function extrasCobro(c) {
  if (!c.mp_token) return { texto: "", claves: "" };
  return {
    texto: "\nCobros: si la persona ya decidió comprar y el precio exacto está en la información de la marca, podés mandarle un link de pago.\n",
    claves: `\n- "cobro": SOLO si ya decidió comprar y el precio está en la marca: {"concepto": "qué paga", "monto": número}; si no, null`,
  };
}

// Al enviar la respuesta: si propuso cobrar, crea el link y lo agrega al mensaje (una sola vez).
export async function cobrarSiCorresponde(env, c, ct, d) {
  if (!d.cobro?.monto || d.cobro.link) return d.respuesta;
  const r = await crearCobro(env, c, ct.id, d.cobro.concepto || "Compra", d.cobro.monto);
  d.cobro.link = r.link;
  d.cobro.id = r.id;
  return `${d.respuesta}\n\nPodés pagar acá: ${r.link}`;
}

// Aviso de Mercado Pago: se confirma consultando el pago con el token del cliente.
export async function avisoMercadoPago(req, env, clienteId) {
  const url = new URL(req.url);
  const b = await req.json().catch(() => ({}));
  const pagoId = b.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id");
  const tipo = b.type || url.searchParams.get("type") || url.searchParams.get("topic");
  if (!pagoId || (tipo && tipo !== "payment")) return new Response("ok");
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c?.mp_token) return new Response("ok");
  const pago = await (await fetch(`${MP_API}/v1/payments/${encodeURIComponent(pagoId)}`, { headers: { Authorization: "Bearer " + (await descifrar(env, c.mp_token)) } })).json();
  if (pago.status !== "approved" || !pago.external_reference) return new Response("ok");
  const cobro = await env.DB.prepare("SELECT * FROM cobros WHERE id = ? AND cliente_id = ?").bind(pago.external_reference, c.id).first();
  if (!cobro || cobro.estado === "pagado") return new Response("ok");
  await env.DB.prepare("UPDATE cobros SET estado = 'pagado', pago_id = ?, pagado_en = datetime('now') WHERE id = ?").bind(String(pago.id), cobro.id).run();
  if (cobro.contacto_id) await env.DB.prepare("UPDATE contactos SET etapa = 'cliente' WHERE id = ?").bind(cobro.contacto_id).run();
  const ct = cobro.contacto_id ? await env.DB.prepare("SELECT nombre, usuario, telefono FROM contactos WHERE id = ?").bind(cobro.contacto_id).first() : null;
  await registrar(env, c.id, "cobrado", `$${cobro.monto}: ${cobro.concepto}`);
  await notificar(env, c.id, `💰 ¡Cobrado en ${c.nombre}! $${cobro.monto} — ${cobro.concepto}${ct ? ` (${ct.nombre || ct.usuario || ct.telefono})` : ""}`);
  return new Response("ok");
}

// Cron: avisa al equipo de los links sin pagar después de 2 días (una vez).
export async function recordarCobros(env) {
  const { results } = await env.DB.prepare(
    "SELECT cb.*, ct.nombre, ct.usuario, ct.telefono FROM cobros cb LEFT JOIN contactos ct ON ct.id = cb.contacto_id " +
    "WHERE cb.estado = 'pendiente' AND cb.avisado = 0 AND cb.creado < datetime('now', '-2 days') LIMIT 5"
  ).all();
  for (const cb of results) {
    await env.DB.prepare("UPDATE cobros SET avisado = 1 WHERE id = ?").bind(cb.id).run();
    await notificar(env, cb.cliente_id, `💳 ${cb.nombre || cb.usuario || cb.telefono || "Un cliente"} todavía no pagó $${cb.monto} (${cb.concepto}). ¿Le escribís para ayudarlo? Link: ${cb.link}`);
  }
}

export async function guardarMercadoPago(env, clienteId, token) {
  const t = String(token || "").trim();
  const yo = await (await fetch(`${MP_API}/users/me`, { headers: { Authorization: "Bearer " + t } })).json();
  if (!yo.id) throw new Error("Mercado Pago no reconoció ese token (usá el Access Token de producción)");
  await env.DB.prepare("UPDATE clientes SET mp_token = ? WHERE id = ?").bind(await cifrar(env, t), clienteId).run();
  return { ok: true, cuenta: yo.nickname || yo.email || String(yo.id) };
}
