// Publicador: cola de publicación (no más de N posts por día, en los mejores horarios, nunca varios juntos)
// y publicación también en la página de Facebook del cliente.

import { descifrar, horaLocal, registrar, notificar } from "./comun.js";

const FB_API = "https://graph.facebook.com/v23.0";

// Diferencia (en minutos) entre la hora local del cliente y UTC.
function desfase(zona) {
  const ahora = new Date();
  return (new Date(ahora.toLocaleString("en-US", { timeZone: zona })) - new Date(ahora.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
}

// Decide si un post aprobado sale ya o va a la cola. Devuelve {ahora: true} o {programada: "AAAA-MM-DD HH:MM" (UTC), local}.
export async function turnoDePublicacion(env, c) {
  const cfg = JSON.parse(c.publicacion_config || "{}");
  const porDia = cfg.por_dia || 2, horarios = (cfg.horarios?.length ? cfg.horarios : ["12:00", "19:00"]).slice().sort();
  const off = desfase(c.zona);
  const reciente = await env.DB.prepare(
    "SELECT 1 FROM propuestas WHERE cliente_id = ? AND tipo IN ('post', 'video') AND estado = 'publicada' AND actualizado > datetime('now', '-3 hours')"
  ).bind(c.id).first();
  const ocupados = new Set((await env.DB.prepare(
    "SELECT programada FROM propuestas WHERE cliente_id = ? AND estado = 'programada'"
  ).bind(c.id).all()).results.map((x) => x.programada));
  const contarDia = async (fechaLocal) => {
    const desde = new Date(Date.parse(fechaLocal + "T00:00:00Z") - off * 60000).toISOString().slice(0, 19).replace("T", " ");
    const hasta = new Date(Date.parse(fechaLocal + "T00:00:00Z") + (1440 - off) * 60000).toISOString().slice(0, 19).replace("T", " ");
    return (await env.DB.prepare(
      "SELECT COUNT(*) n FROM propuestas WHERE cliente_id = ? AND tipo IN ('post', 'video') AND ((estado = 'publicada' AND actualizado >= ? AND actualizado < ?) OR (estado = 'programada' AND programada >= ? AND programada < ?))"
    ).bind(c.id, desde, hasta, desde, hasta).first()).n;
  };
  const { fecha: hoy, hora } = horaLocal(c.zona);
  if (!reciente && (await contarDia(hoy)) < porDia) return { ahora: true };
  for (let d = 0; d < 14; d++) {
    const fecha = new Date(Date.parse(hoy + "T12:00:00Z") + d * 86400000).toISOString().slice(0, 10);
    if ((await contarDia(fecha)) >= porDia) continue;
    for (const h of horarios) {
      if (d === 0 && h <= hora) continue;
      const utc = new Date(Date.parse(`${fecha}T${h}:00Z`) - off * 60000).toISOString().slice(0, 16).replace("T", " ");
      if (!ocupados.has(utc)) return { programada: utc, local: `${d === 0 ? "hoy" : d === 1 ? "mañana" : fecha.split("-").reverse().join("/")} a las ${h}` };
    }
  }
  return { ahora: true };
}

// Cron: publica lo programado cuando llega su horario. `ejecutar` es el del hub.
export async function publicarProgramadas(env, ejecutar) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM propuestas WHERE estado = 'programada' AND programada <= strftime('%Y-%m-%d %H:%M', 'now') ORDER BY programada LIMIT 2"
  ).all();
  for (const p of results) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'aprobada', actualizado = datetime('now') WHERE id = ? AND estado = 'programada'").bind(p.id).run();
    await ejecutar(env, p.id);
  }
}

// Después de publicar en Instagram: lo mismo en la página de Facebook (si el cliente lo activó).
export async function publicarEnFacebook(env, c, texto, url, esVideo) {
  const cfg = JSON.parse(c.publicacion_config || "{}");
  if (!cfg.facebook || !c.fb_pagina_id || !c.fb_token) return null;
  try {
    const token = await descifrar(env, c.fb_token);
    const r = await fetch(`${FB_API}/${c.fb_pagina_id}/${esVideo ? "videos" : "photos"}`, {
      method: "POST",
      body: new URLSearchParams(esVideo ? { file_url: url, description: texto, access_token: token } : { url, message: texto, access_token: token }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error?.message || JSON.stringify(j));
    const enlace = `https://www.facebook.com/${j.post_id || j.id}`;
    await registrar(env, c.id, "publicada", `Facebook: ${enlace}`);
    return enlace;
  } catch (e) {
    await registrar(env, c.id, "error", "publicar en Facebook: " + e.message);
    await notificar(env, c.id, `⚠️ Se publicó en Instagram pero no en Facebook (${c.nombre}): ${e.message}`);
    return null;
  }
}
