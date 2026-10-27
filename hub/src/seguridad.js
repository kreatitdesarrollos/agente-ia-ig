// Agente de seguridad: chequeos pasivos y defensivos sobre los sistemas propios de cada cliente.
// Cada 15 min (acá): disponibilidad, HTTPS y encabezados. Cada hora (acá): accesos fallidos, invitaciones viejas y
// conexiones caídas. Una vez por día (seguridad.py en GitHub): certificados, archivos expuestos, DNS del email y
// claves filtradas en el repositorio. Los hallazgos críticos avisan al instante por Telegram.

import { registrar, notificar, despacharWorkflow } from "./comun.js";

export const COMO_ARREGLAR = {
  disponible: "Revisá el hosting o el servidor: si es cPanel, que el dominio apunte bien y que no se haya terminado el plan.",
  https: "Activá la redirección de http a https (en cPanel: Dominios → Forzar HTTPS; en Cloudflare: Always Use HTTPS).",
  encabezados: "Agregá en el servidor los encabezados Strict-Transport-Security, X-Content-Type-Options: nosniff y X-Frame-Options: SAMEORIGIN (en Laravel con un middleware; en cPanel con .htaccess).",
  version: "Ocultá la versión del servidor y de PHP (expose_php = Off en php.ini; ServerTokens Prod en Apache).",
  certificado: "Renová el certificado SSL (en cPanel: SSL/TLS Status → Run AutoSSL).",
  archivos: "URGENTE: bloqueá el acceso a esos archivos (que la carpeta pública del dominio sea /public de Laravel, o reglas en .htaccess) y cambiá todas las claves que contengan.",
  email: "Corregí los registros DNS del dominio: un único SPF sin +all, un DMARC con direcciones mailto: válidas, y registros MX.",
  secretos: "URGENTE: sacá esa clave del repositorio y generá una nueva (la vieja ya hay que considerarla expuesta).",
  accesos: "Muchos intentos fallidos: si no fueron ustedes, puede ser alguien probando claves. Revisá el equipo con acceso y quitá a quien no corresponda.",
  invitaciones: "Hay invitaciones sin usar hace más de 7 días: si ya no hacen falta, quitá esos usuarios.",
  conexiones: "Una conexión con un servicio externo está fallando: reconectala desde Mi cuenta / Clientes.",
};

// Guarda el resultado de un chequeo y avisa si aparece un problema crítico nuevo (o si se resolvió).
export async function anotar(env, clienteId, activo, chequeo, nivel, detalle) {
  const previo = await env.DB.prepare("SELECT nivel FROM seguridad_hallazgos WHERE cliente_id = ? AND activo = ? AND chequeo = ?").bind(clienteId, activo, chequeo).first();
  await env.DB.prepare(
    "INSERT INTO seguridad_hallazgos (cliente_id, activo, chequeo, nivel, detalle) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(cliente_id, activo, chequeo) DO UPDATE SET nivel = excluded.nivel, detalle = excluded.detalle, ultima_vez = datetime('now'), " +
    "primera_vez = CASE WHEN seguridad_hallazgos.nivel = excluded.nivel THEN seguridad_hallazgos.primera_vez ELSE datetime('now') END"
  ).bind(clienteId, activo, chequeo, nivel, String(detalle || "").slice(0, 600)).run();
  if (nivel === "critico" && previo?.nivel !== "critico") {
    await registrar(env, clienteId, "seguridad", `🔴 ${chequeo} en ${activo}: ${detalle}`);
    await notificar(env, clienteId, `🛡️🔴 Seguridad — problema crítico en ${activo}\n${detalle}\n\nCómo arreglarlo: ${COMO_ARREGLAR[chequeo] || "mirá el panel → Seguridad."}`);
  } else if (previo?.nivel === "critico" && nivel !== "critico") {
    await registrar(env, clienteId, "seguridad", `✅ resuelto: ${chequeo} en ${activo}`);
    await notificar(env, clienteId, `🛡️✅ Seguridad — se resolvió "${chequeo}" en ${activo}.`);
  }
}

// ---------------------------------------------------------------- intentos fallidos (los cuenta el hub)

export async function contarIntento(env, tipo) {
  const clave = `intentos:${tipo}:${new Date().toISOString().slice(0, 13)}`;
  const n = Number((await env.ARCHIVOS.get(clave)) || 0) + 1;
  await env.ARCHIVOS.put(clave, String(n), { expirationTtl: 7200 });
}

// ---------------------------------------------------------------- cada 15 minutos: sitios (hasta 5 por pasada)

const UA = { "User-Agent": "KreatitSeguridad/1.0 (monitoreo de sitios propios)" };

export async function chequearSitios(env, clienteId = null) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM seguridad_activos WHERE (? IS NULL OR cliente_id = ?) AND (? IS NOT NULL OR ultimo_chequeo IS NULL OR ultimo_chequeo < datetime('now', '-14 minutes')) " +
    "ORDER BY ultimo_chequeo IS NOT NULL, ultimo_chequeo LIMIT 5"
  ).bind(clienteId, clienteId, clienteId).all();
  for (const a of results) await chequearSitio(env, a);
}

async function chequearSitio(env, a) {
  const inicio = Date.now();
  let r = null, error = "";
  try {
    r = await fetch(a.url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    error = String(e.message || e);
  }
  const ms = Date.now() - inicio;
  if (!r || r.status >= 500) {
    const fallas = a.fallas + 1;
    await env.DB.prepare("UPDATE seguridad_activos SET fallas = ?, ultimo_chequeo = datetime('now'), ms = NULL WHERE id = ?").bind(fallas, a.id).run();
    if (fallas >= 2) await anotar(env, a.cliente_id, a.url, "disponible", "critico", `No responde (${r ? "error " + r.status : error || "sin respuesta"}), ${fallas} chequeos seguidos.`);
    return;
  }
  await env.DB.prepare("UPDATE seguridad_activos SET fallas = 0, ultimo_chequeo = datetime('now'), ms = ? WHERE id = ?").bind(ms, a.id).run();
  await anotar(env, a.cliente_id, a.url, "disponible", ms > 5000 ? "aviso" : "ok", `Responde (${r.status}) en ${ms} ms${ms > 5000 ? ": está lento" : ""}.`);

  const h = r.headers;
  const faltan = [];
  if (!h.get("strict-transport-security")) faltan.push("Strict-Transport-Security (HSTS)");
  if (!h.get("x-content-type-options")) faltan.push("X-Content-Type-Options");
  if (!h.get("x-frame-options") && !(h.get("content-security-policy") || "").includes("frame-ancestors")) faltan.push("protección contra clickjacking (X-Frame-Options)");
  await anotar(env, a.cliente_id, a.url, "encabezados", faltan.length ? "aviso" : "ok", faltan.length ? "Faltan: " + faltan.join(", ") + "." : "Tiene los encabezados de seguridad básicos.");
  const delata = [h.get("x-powered-by"), /\d/.test(h.get("server") || "") ? h.get("server") : null].filter(Boolean);
  await anotar(env, a.cliente_id, a.url, "version", delata.length ? "aviso" : "ok", delata.length ? "Muestra la versión del software: " + delata.join(" · ") : "No muestra versiones del servidor.");
  await r.body?.cancel();

  // http → https
  if (a.url.startsWith("https://")) {
    try {
      const http = await fetch(a.url.replace("https://", "http://"), { headers: UA, redirect: "manual", signal: AbortSignal.timeout(10000) });
      const destino = http.headers.get("location") || "";
      const ok = [301, 302, 307, 308].includes(http.status) && destino.startsWith("https://");
      await anotar(env, a.cliente_id, a.url, "https", ok ? "ok" : "aviso", ok ? "La versión http redirige a https." : `La versión http no redirige a https (responde ${http.status}).`);
      await http.body?.cancel();
    } catch {
      await anotar(env, a.cliente_id, a.url, "https", "ok", "La versión http no está disponible (solo https).");
    }
  }
}

// ---------------------------------------------------------------- cada hora: el hub por dentro

export async function chequeosInternos(env) {
  const hora = new Date().toISOString().slice(0, 13);
  if (await env.ARCHIVOS.get("seg-interno:" + hora)) return;
  await env.ARCHIVOS.put("seg-interno:" + hora, "1", { expirationTtl: 7200 });

  // intentos fallidos de la última hora y la anterior (login, API, webhooks)
  const horas = [hora, new Date(Date.now() - 3600000).toISOString().slice(0, 13)];
  const tipos = { login: "códigos de login incorrectos", api: "llamadas con clave inválida a la API", webhook: "webhooks con firma inválida" };
  const conteo = [];
  let total = 0;
  for (const [t, nombre] of Object.entries(tipos)) {
    let n = 0;
    for (const h of horas) n += Number((await env.ARCHIVOS.get(`intentos:${t}:${h}`)) || 0);
    total += n;
    if (n) conteo.push(`${n} ${nombre}`);
  }
  await anotar(env, env.CLIENTE_DEFAULT, "hub", "accesos", total > 60 ? "critico" : total > 15 ? "aviso" : "ok",
    conteo.length ? `Últimas 2 horas: ${conteo.join(", ")}.` : "Sin intentos fallidos en las últimas 2 horas.");

  const { results: clientes } = await env.DB.prepare("SELECT id FROM clientes WHERE activo = 1").all();
  for (const c of clientes) {
    const viejas = (await env.DB.prepare(
      "SELECT nombre FROM usuarios WHERE cliente_id = ? AND activo = 1 AND tg_chat IS NULL AND invitacion IS NOT NULL AND creado < datetime('now', '-7 days')"
    ).bind(c.id).all()).results;
    await anotar(env, c.id, "panel", "invitaciones", viejas.length ? "aviso" : "ok",
      viejas.length ? `Invitaciones sin usar hace más de 7 días: ${viejas.map((u) => u.nombre).join(", ")}.` : "No hay invitaciones viejas sin usar.");
    const caidas = (await env.DB.prepare(
      "SELECT detalle FROM eventos WHERE cliente_id = ? AND tipo = 'error' AND creado > datetime('now', '-24 hours') AND " +
      "(detalle LIKE '%token%' OR detalle LIKE '%Google Play%' OR detalle LIKE '%sincronizar Instagram%' OR detalle LIKE '%resultados de la campaña%') LIMIT 3"
    ).bind(c.id).all()).results;
    await anotar(env, c.id, "panel", "conexiones", caidas.length ? "aviso" : "ok",
      caidas.length ? "Fallas recientes: " + caidas.map((e) => e.detalle.slice(0, 120)).join(" | ") : "Las conexiones con servicios externos responden bien.");
  }
}

// ---------------------------------------------------------------- una vez por día: el chequeo profundo en GitHub

export async function chequeoDiario(env) {
  const fecha = new Date().toISOString().slice(0, 10);
  if (new Date().getUTCHours() < 9 || (await env.ARCHIVOS.get("seg-diario:" + fecha))) return; // 6 de la mañana en Argentina
  await env.ARCHIVOS.put("seg-diario:" + fecha, "1", { expirationTtl: 172800 });
  await despacharWorkflow(env, "seguridad.yml", { cliente: "" });
}

// ---------------------------------------------------------------- API para seguridad.py y para el panel

export async function apiSeguridadAgente(req, env, ruta) {
  if (ruta === "activos") {
    const { results } = await env.DB.prepare("SELECT id, cliente_id, url FROM seguridad_activos").all();
    return Response.json({ activos: results, agencia: env.CLIENTE_DEFAULT });
  }
  if (ruta === "resultados" && req.method === "POST") {
    const b = await req.json();
    for (const x of b.resultados || []) await anotar(env, x.cliente_id, x.activo, x.chequeo, x.nivel, x.detalle);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "no existe" }, { status: 404 });
}

export async function apiPanelSeguridad(req, env, yo, puede, ruta, url) {
  const json = (d, s = 200) => Response.json(d, { status: s });
  if (ruta === "seguridad" && req.method === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return json({ error: "no tenés acceso" }, 403);
    const activos = (await env.DB.prepare("SELECT * FROM seguridad_activos WHERE cliente_id = ? ORDER BY creado").bind(cliente).all()).results;
    const hallazgos = (await env.DB.prepare(
      "SELECT * FROM seguridad_hallazgos WHERE cliente_id = ? ORDER BY CASE nivel WHEN 'critico' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, activo, chequeo"
    ).bind(cliente).all()).results;
    const criticos = hallazgos.filter((h) => h.nivel === "critico").length, avisos = hallazgos.filter((h) => h.nivel === "aviso").length;
    return json({ activos, hallazgos: hallazgos.map((h) => ({ ...h, como: COMO_ARREGLAR[h.chequeo] })), puntaje: Math.max(0, 100 - criticos * 25 - avisos * 6) });
  }
  if (ruta === "seguridad/activos" && req.method === "POST") {
    const b = await req.json();
    if (!puede(yo, b.cliente)) return json({ error: "no tenés acceso" }, 403);
    let u;
    try { u = new URL(String(b.url).trim()); } catch { return json({ error: "la dirección no es válida (ej. https://misitio.com)" }, 400); }
    if (!["http:", "https:"].includes(u.protocol)) return json({ error: "tiene que empezar con https://" }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO seguridad_activos (id, cliente_id, url, nombre) VALUES (?, ?, ?, ?)")
      .bind("sa-" + crypto.randomUUID().slice(0, 10), b.cliente, u.origin + (u.pathname === "/" ? "" : u.pathname), b.nombre || u.hostname).run();
    await chequearSitios(env, b.cliente);
    return json({ ok: true });
  }
  const borrar = ruta.match(/^seguridad\/activos\/([\w-]+)$/);
  if (borrar && req.method === "DELETE") {
    const a = await env.DB.prepare("SELECT * FROM seguridad_activos WHERE id = ?").bind(borrar[1]).first();
    if (!a || !puede(yo, a.cliente_id)) return json({ error: "no tenés acceso" }, 403);
    await env.DB.prepare("DELETE FROM seguridad_activos WHERE id = ?").bind(a.id).run();
    await env.DB.prepare("DELETE FROM seguridad_hallazgos WHERE cliente_id = ? AND activo = ?").bind(a.cliente_id, a.url).run();
    return json({ ok: true });
  }
  if (ruta === "seguridad/revisar" && req.method === "POST") {
    const b = await req.json();
    if (!puede(yo, b.cliente)) return json({ error: "no tenés acceso" }, 403);
    await env.DB.prepare("UPDATE seguridad_activos SET ultimo_chequeo = NULL WHERE cliente_id = ?").bind(b.cliente).run();
    await chequearSitios(env, b.cliente);
    await despacharWorkflow(env, "seguridad.yml", { cliente: b.cliente });
    return json({ ok: true, nota: "Revisión rápida hecha; el chequeo profundo (certificados, archivos, email) tarda 1–2 minutos" });
  }
  return null;
}
