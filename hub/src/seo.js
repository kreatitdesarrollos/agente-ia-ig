// Redactor SEO: artículos para el blog del cliente (los escribe seo.py), publicación en WordPress o en una página
// del hub, y la programación semanal.

import { cifrar, descifrar, registrar, notificar, destinatarios, tg, horaLocal, despacharWorkflow, hex } from "./comun.js";

export async function apiSeoAgente(req, env, ruta, url) {
  if (ruta === "seo") {
    const c = await env.DB.prepare("SELECT id, nombre, marca, seo_config FROM clientes WHERE id = ?").bind(url.searchParams.get("cliente")).first();
    if (!c) return Response.json({ error: "no existe" }, { status: 404 });
    const previos = (await env.DB.prepare("SELECT titulo FROM propuestas WHERE cliente_id = ? AND tipo = 'articulo' AND estado != 'descartada' ORDER BY creado DESC LIMIT 40").bind(c.id).all()).results.map((x) => x.titulo);
    return Response.json({ cliente: { id: c.id, nombre: c.nombre, marca: c.marca }, temas: JSON.parse(c.seo_config || "{}").temas || [], previos });
  }
  if (ruta === "articulo" && req.method === "POST") {
    const b = await req.json();
    const id = `${b.cliente_id}-b${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'articulo', ?, ?)").bind(id, b.cliente_id, b.titulo, JSON.stringify(b.datos)).run();
    await registrar(env, b.cliente_id, "articulo", `${b.titulo} (${b.datos.palabras} palabras)`);
    await vistaPreviaArticulo(env, id);
    return Response.json({ ok: true, id });
  }
  return null;
}

export async function vistaPreviaArticulo(env, id) {
  const p = await env.DB.prepare("SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?").bind(id).first();
  const d = JSON.parse(p.datos);
  const botones = { inline_keyboard: [[{ text: "✅ Publicar", callback_data: "ok:" + id }, { text: "🔄 Otro", callback_data: "otra:" + id }, { text: "❌ Descartar", callback_data: "no:" + id }], [{ text: "📖 Leerlo completo", url: `${env.URL_PUBLICA}/panel` }]] };
  const inicio = (d.texto || "").replace(/\s+/g, " ").trim().slice(0, 600);
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const m = await tg(env, "sendMessage", { chat_id: chat, reply_markup: botones, disable_web_page_preview: true,
      text: `🌐 ${p.cliente_nombre}: artículo para el blog\n«${d.titulo}»\nBúsqueda en Google: "${d.palabra_clave}" · ${d.palabras} palabras\n\n${d.meta}\n\n${inicio}…` });
    if (m?.result?.message_id) await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
  }
}

// Al aprobar: a WordPress si está conectado; si no, queda publicado en el hub (/blog/<cliente>/<slug>).
export async function ejecutarArticulo(env, id) {
  const tomada = await env.DB.prepare("UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'").bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está publicando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  try {
    let enlace = `${env.URL_PUBLICA}/blog/${c.id}/${d.slug}`;
    if (c.wp_config) {
      const wp = JSON.parse(await descifrar(env, c.wp_config));
      const r = await fetch(`${wp.url.replace(/\/$/, "")}/wp-json/wp/v2/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${wp.usuario}:${wp.clave}`) },
        body: JSON.stringify({ title: d.titulo, content: d.html, excerpt: d.meta, slug: d.slug, status: "publish" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error("WordPress: " + (j.message || r.status));
      enlace = j.link;
    }
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?").bind(JSON.stringify({ enlace }), id).run();
    await registrar(env, c.id, "publicada", `blog: ${d.titulo} ${enlace}`);
    await notificar(env, c.id, `🌐 Artículo publicado en ${c.nombre}: ${enlace}`);
    return { ok: true, enlace };
  } catch (e) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?").bind(JSON.stringify({ error: e.message }), id).run();
    await notificar(env, c.id, `⚠️ No pude publicar el artículo en ${c.nombre}: ${e.message}`);
    return { error: e.message };
  }
}

// Página pública del artículo (cuando el cliente no tiene WordPress).
export async function paginaBlog(env, clienteId, slugBuscado) {
  const { results } = await env.DB.prepare("SELECT p.datos, c.nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.cliente_id = ? AND p.tipo = 'articulo' AND p.estado = 'publicada'").bind(clienteId).all();
  const fila = results.find((r) => JSON.parse(r.datos).slug === slugBuscado);
  if (!fila) return new Response("No encontrado", { status: 404 });
  const d = JSON.parse(fila.datos);
  const esc = (t) => String(t).replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]));
  const html = d.html.replace(/<(?!\/?(h2|h3|p|ul|li|strong|a)(\s|>))[^>]*>/gi, "").replace(/<a\s+[^>]*?href="(https?:[^"]+)"[^>]*>/gi, '<a href="$1" rel="noopener">');
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.titulo)}</title><meta name="description" content="${esc(d.meta)}">
<style>body{font:18px/1.7 Georgia,serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#222;background:#fff}h1{font:700 34px/1.2 system-ui,sans-serif}h2,h3{font-family:system-ui,sans-serif}a{color:#4b3fb0}</style>
<h1>${esc(d.titulo)}</h1><p style="color:#666;font:15px system-ui">${esc(fila.nombre)}</p>${html}</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Cron: los jueves desde las 10 (hora del cliente), para los clientes con el blog activo. Uno por pasada.
export async function articulosSemanales(env) {
  const { results } = await env.DB.prepare("SELECT * FROM clientes WHERE activo = 1").all();
  for (const c of results) {
    const cfg = JSON.parse(c.seo_config || "{}");
    if (!cfg.activo || !cfg.temas?.length) continue;
    const { fecha, hora } = horaLocal(c.zona);
    const dia = new Intl.DateTimeFormat("en-US", { timeZone: c.zona, weekday: "short" }).format(new Date());
    if (dia !== "Thu" || hora < "10:00" || c.ultimo_seo === fecha) continue;
    await env.DB.prepare("UPDATE clientes SET ultimo_seo = ? WHERE id = ?").bind(fecha, c.id).run();
    await registrar(env, c.id, "escribiendo", "el artículo de la semana");
    await despacharWorkflow(env, "seo.yml", { cliente: c.id, tema: "" });
    return;
  }
}

export async function guardarSeo(env, clienteId, b) {
  if (b.config) {
    await env.DB.prepare("UPDATE clientes SET seo_config = ? WHERE id = ?").bind(JSON.stringify({
      activo: !!b.config.activo, temas: (b.config.temas || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8), por_mes: 4,
    }), clienteId).run();
  }
  if (b.wp?.url && b.wp?.usuario && b.wp?.clave) {
    const url = b.wp.url.trim().replace(/\/$/, "");
    const r = await fetch(`${url}/wp-json/wp/v2/users/me`, { headers: { Authorization: "Basic " + btoa(`${b.wp.usuario.trim()}:${b.wp.clave.trim()}`) } });
    if (!r.ok) throw new Error("WordPress no aceptó el usuario o la contraseña de aplicación (" + r.status + ")");
    await env.DB.prepare("UPDATE clientes SET wp_config = ? WHERE id = ?").bind(await cifrar(env, JSON.stringify({ url, usuario: b.wp.usuario.trim(), clave: b.wp.clave.trim() })), clienteId).run();
  }
  return { ok: true };
}
