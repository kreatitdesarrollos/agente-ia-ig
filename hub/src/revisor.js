// Revisor de calidad: lee cada propuesta pendiente antes de que la apruebes (o antes de que salga sola, en modo
// automático) y marca datos inventados, promesas que no están en la marca, errores y tono. Si encuentra algo,
// avisa en el mismo hilo de Telegram con la corrección lista para usar.

import { gemini, destinatarios, tg, registrar } from "./comun.js";

// Qué texto mira en cada tipo de propuesta, y en qué campo va la corrección.
const CAMPOS = {
  post: { leer: (d) => `${d.caption}\n\n${d.hashtags || ""}`, campo: "caption" },
  video: { leer: (d) => `${d.caption}\n\n${d.hashtags || ""}`, campo: "caption" },
  respuesta: { leer: (d) => `Comentario: «${d.comentario}»\nRespuesta: ${d.respuesta}`, campo: "respuesta" },
  mensaje: { leer: (d) => `Mensaje del cliente: «${d.entrante}»\nRespuesta: ${d.respuesta}`, campo: "respuesta" },
  resena: { leer: (d) => `Reseña (${d.estrellas}★): «${d.comentario}»\nRespuesta: ${d.respuesta}`, campo: "respuesta" },
  email: { leer: (d) => `Asunto: ${d.asunto}\n\n${d.cuerpo}`, campo: "cuerpo" },
  prospecto: { leer: (d) => `Asunto: ${d.asunto}\n\n${d.cuerpo}`, campo: "cuerpo" },
  articulo: { leer: (d) => `${d.titulo}\n\n${(d.texto || "").slice(0, 6000)}`, campo: null },
  anuncio: { leer: (d) => `Campaña "${d.nombre}": ${d.motivo} / ${d.esperado}`, campo: null },
};

// Hasta 3 por pasada. `acciones` trae ejecutar() y enviarVistaPrevia() del hub (para el modo automático).
export async function revisarPendientes(env, acciones) {
  const { results } = await env.DB.prepare(
    "SELECT p.*, c.marca, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id " +
    "WHERE p.estado = 'pendiente' AND json_extract(p.datos, '$.revision') IS NULL AND p.creado > datetime('now', '-2 days') " +
    "ORDER BY json_extract(p.datos, '$.auto_pendiente') DESC, p.creado LIMIT 3"
  ).all();
  for (const p of results) await revisar(env, p, acciones);
}

async function revisar(env, p, acciones) {
  const datos = JSON.parse(p.datos);
  const tipo = CAMPOS[p.tipo];
  if (!tipo) return marcar(env, p.id, datos, { ok: true, problemas: [] });
  let r;
  try {
    r = await gemini(env, `${p.marca}

---
Sos el revisor de calidad de ${p.cliente_nombre}. Antes de que se publique o se envíe, revisá este texto (tipo: ${p.tipo}):

"""
${tipo.leer(datos)}
"""

Respondé SOLO con un JSON:
- "ok": true si se puede publicar tal cual
- "problemas": lista corta (máx. 3) de problemas REALES, en una frase cada uno
- "sugerencia": ${tipo.campo ? "el texto corregido completo (solo la parte que se publica/envía), o \"\" si está ok" : "\"\""}

Marcá como problema SOLO esto: datos que no están en la información de la marca (precios, plazos, condiciones, cifras,
funciones, premios), promesas exageradas o que no se pueden cumplir, errores de ortografía o gramática, tono que no
corresponde a la marca, información sensible o inapropiada, idioma distinto al del cliente, o algo ofensivo.
No marques cuestiones de estilo ni gustos personales: si el texto es correcto, "ok": true.`);
  } catch (e) {
    console.log("Revisor:", e.message);
    return; // se reintenta en la próxima pasada
  }
  const revision = { ok: !!r.ok, problemas: (r.problemas || []).slice(0, 3), sugerencia: tipo.campo ? r.sugerencia || "" : "", fecha: new Date().toISOString() };
  if (revision.ok) revision.problemas = [];
  await marcar(env, p.id, datos, revision);

  if (datos.auto_pendiente) { // modo automático: sale solo si el revisor lo aprueba
    if (revision.ok) {
      await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada', actualizado = datetime('now') WHERE id = ?").bind(p.id).run();
      await acciones.ejecutar(env, p.id);
    } else {
      await registrar(env, p.cliente_id, "revisor", `frenó la publicación automática: ${revision.problemas.join(" / ")}`);
      await acciones.enviarVistaPrevia(env, p.id);
      await avisar(env, p, revision, "🛑 El revisor frenó la publicación automática");
    }
    return;
  }
  if (!revision.ok) await avisar(env, p, revision, "⚠️ El revisor de calidad encontró algo");
}

async function marcar(env, id, datos, revision) {
  datos.revision = revision;
  await env.DB.prepare("UPDATE propuestas SET datos = ? WHERE id = ?").bind(JSON.stringify(datos), id).run();
}

async function avisar(env, p, revision, titulo) {
  const texto = `${titulo} (${p.cliente_nombre}: ${p.titulo}):\n• ${revision.problemas.join("\n• ")}` +
    (revision.sugerencia ? `\n\nCorrección propuesta:\n${revision.sugerencia}` : "");
  const botones = revision.sugerencia ? { inline_keyboard: [[{ text: "✍️ Usar corrección", callback_data: "corr:" + p.id }]] } : undefined;
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const original = await env.DB.prepare("SELECT message_id FROM mensajes_tg WHERE chat_id = ? AND propuesta_id = ? ORDER BY message_id DESC LIMIT 1").bind(chat, p.id).first();
    await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4000), reply_markup: botones, ...(original ? { reply_to_message_id: original.message_id } : {}) });
  }
}

// "Usar corrección": reemplaza el texto por el que propuso el revisor.
export async function usarCorreccion(env, id) {
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  if (!p || p.estado !== "pendiente") return { error: "ya no está pendiente" };
  const datos = JSON.parse(p.datos);
  const campo = CAMPOS[p.tipo]?.campo;
  if (!campo || !datos.revision?.sugerencia) return { error: "no hay corrección para usar" };
  datos[campo] = datos.revision.sugerencia;
  if (p.tipo === "post" || p.tipo === "video") datos.hashtags = ""; // la corrección trae el texto completo, hashtags incluidos
  datos.revision = { ok: true, problemas: [], sugerencia: "", fecha: new Date().toISOString(), corregido: true };
  await env.DB.prepare("UPDATE propuestas SET datos = ?, actualizado = datetime('now') WHERE id = ?").bind(JSON.stringify(datos), id).run();
  return { ok: true };
}
