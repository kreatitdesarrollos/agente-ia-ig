// Investigador de mercado: el informe lo arma GitHub Actions (investigador.py) con noticias reales de Google
// Noticias; acá se guarda, se manda por Telegram con botones para convertir cada idea en un post, y se programa.

import { tg, destinatarios, registrar, horaLocal, despacharWorkflow, responder } from "./comun.js";

export async function guardarInvestigacion(env, clienteId, datos) {
  const c = await env.DB.prepare("SELECT id, nombre FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c) return { error: "no existe el cliente" };
  const texto = textoInforme(datos);
  const r = await env.DB.prepare("INSERT INTO informes (cliente_id, tipo, texto, datos) VALUES (?, 'mercado', ?, ?)")
    .bind(c.id, texto, JSON.stringify(datos)).run();
  const id = r.meta.last_row_id;
  await registrar(env, c.id, "investigacion", `${(datos.fuentes || []).length} noticias, ${(datos.ideas || []).length} ideas`);

  const ideas = (datos.ideas || []).slice(0, 5);
  const botones = { inline_keyboard: ideas.map((idea, i) => [{ text: `✨ Post: ${idea.titulo}`.slice(0, 60), callback_data: `idea:${id}:${i}` }]) };
  const mensaje = `🔎 Investigación de mercado — ${c.nombre}\n\n${texto}`.slice(0, 3900) + "\n\nTocá una idea para generar el post. Las fuentes están en el panel → Investigación.";
  for (const chat of await destinatarios(env, c.id)) {
    await tg(env, "sendMessage", { chat_id: chat, text: mensaje, reply_markup: botones, disable_web_page_preview: true });
  }
  return { ok: true, id };
}

function textoInforme(d) {
  const lista = (titulo, items) => (items?.length ? `${titulo}\n${items.map((x) => "• " + x).join("\n")}\n\n` : "");
  return `${d.resumen || ""}\n\n` +
    lista("🏁 Competencia", d.competencia) +
    lista("📈 Tendencias y oportunidades", d.tendencias) +
    lista("📅 Fechas para aprovechar", d.fechas) +
    lista("💡 Ideas de posts", (d.ideas || []).map((i, n) => `${n + 1}. ${i.titulo} — ${i.enfoque}`));
}

// Convierte una idea del informe en un pedido al generador.
export async function generarIdea(env, informeId, n, chat) {
  const inf = await env.DB.prepare("SELECT cliente_id, datos FROM informes WHERE id = ?").bind(informeId).first();
  const idea = JSON.parse(inf?.datos || "{}").ideas?.[n];
  if (!idea) return chat && responder(env, chat, "No encontré esa idea.");
  if (chat) await responder(env, chat, `✨ Generando el post "${idea.titulo}"... (1 o 2 minutos)`);
  await registrar(env, inf.cliente_id, "generando", idea.titulo);
  await despacharWorkflow(env, "generar.yml", { cliente: inf.cliente_id, pedido: `${idea.titulo}: ${idea.enfoque}`, producto: "" });
}

// Los miércoles desde las 9:30 (hora del cliente), para los clientes con temas o competidores cargados. Uno por pasada.
export async function investigacionesSemanales(env) {
  const { results } = await env.DB.prepare("SELECT * FROM clientes WHERE activo = 1").all();
  for (const c of results) {
    const cfg = JSON.parse(c.investigacion || "{}");
    if (!cfg.temas?.length && !cfg.competidores?.length) continue;
    const { fecha, hora } = horaLocal(c.zona);
    const dia = new Intl.DateTimeFormat("en-US", { timeZone: c.zona, weekday: "short" }).format(new Date());
    if (dia !== "Wed" || hora < "09:30" || c.ultimo_mercado === fecha) continue;
    await env.DB.prepare("UPDATE clientes SET ultimo_mercado = ? WHERE id = ?").bind(fecha, c.id).run();
    await registrar(env, c.id, "investigando", "la investigación semanal");
    await despacharWorkflow(env, "investigar.yml", { cliente: c.id });
    return;
  }
}
