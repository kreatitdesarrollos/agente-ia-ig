// Gerente: un solo resumen por día (8:30, hora del cliente) con lo que hizo cada agente, lo que espera tu OK,
// lo urgente y las 3 prioridades del día. También a pedido con /resumen en Telegram.

import { gemini, destinatarios, tg, horaLocal } from "./comun.js";

const NOMBRES = { post: "posts", video: "videos", respuesta: "respuestas a comentarios", mensaje: "mensajes", resena: "reseñas",
  email: "emails de seguimiento", prospecto: "propuestas de prospección", anuncio: "campañas", articulo: "artículos del blog", cobro: "cobros" };

export async function armarResumen(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  const filas = async (sql, ...b) => (await env.DB.prepare(sql).bind(clienteId, ...b).all()).results;
  const uno = async (sql) => (await env.DB.prepare(sql).bind(clienteId).first())?.n ?? 0;

  const pendientes = await filas("SELECT tipo, COUNT(*) n FROM propuestas WHERE cliente_id = ? AND estado = 'pendiente' GROUP BY tipo");
  const ayer = await filas("SELECT tipo, COUNT(*) n FROM eventos WHERE cliente_id = ? AND creado > datetime('now', '-24 hours') GROUP BY tipo");
  const cuenta = (t) => ayer.find((x) => x.tipo === t)?.n || 0;
  const criticos = await filas("SELECT activo, chequeo FROM seguridad_hallazgos WHERE cliente_id = ? AND nivel = 'critico'");
  const errores = await filas("SELECT detalle FROM eventos WHERE cliente_id = ? AND tipo = 'error' AND creado > datetime('now', '-24 hours') ORDER BY id DESC LIMIT 3");
  const leadsNuevos = await uno("SELECT COUNT(*) n FROM contactos WHERE cliente_id = ? AND creado > datetime('now', '-24 hours')");
  const calientes = await filas("SELECT nombre, usuario, resumen FROM contactos WHERE cliente_id = ? AND interes = 'alto' AND etapa IN ('interesado', 'conversando') ORDER BY ultimo_mensaje DESC LIMIT 3");
  const mejorPost = (await filas("SELECT texto, alcance, interacciones FROM publicaciones_ig WHERE cliente_id = ? AND fecha > ? ORDER BY interacciones DESC LIMIT 1",
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19)))[0];

  const hecho = [
    [cuenta("publicada"), "publicaciones"], [cuenta("respondido"), "respuestas enviadas"], [cuenta("enviado"), "mensajes enviados"],
    [cuenta("email"), "emails de seguimiento"], [leadsNuevos, "leads nuevos"], [cuenta("prospeccion"), "tandas de prospección"],
    [cuenta("lead"), "contactos que respondieron"],
  ].filter(([n]) => n).map(([n, t]) => `${n} ${t}`);
  const espera = pendientes.map((p) => `${p.n} ${NOMBRES[p.tipo] || p.tipo}`);
  const urgente = [
    ...criticos.map((x) => `seguridad: ${x.chequeo} en ${x.activo}`),
    ...errores.map((e) => e.detalle.slice(0, 100)),
  ];

  let charla = null;
  try {
    charla = await gemini(env, `Sos el gerente del equipo de agentes de IA de ${c.nombre}. Con estos datos, escribí el resumen del día.
Hecho en las últimas 24 h: ${hecho.join(", ") || "nada destacado"}.
Esperando aprobación: ${espera.join(", ") || "nada"}.
Urgente: ${urgente.join(" | ") || "nada"}.
Leads calientes: ${calientes.map((l) => `${l.nombre || "@" + l.usuario}: ${l.resumen || ""}`).join(" | ") || "ninguno"}.
Mejor post de la semana: ${mejorPost ? `"${(mejorPost.texto || "").split("\n")[0].slice(0, 80)}" (alcance ${mejorPost.alcance ?? "?"}, interacciones ${mejorPost.interacciones ?? "?"})` : "sin datos"}.

Respondé SOLO un JSON: {"resumen": "2 frases, cálidas y concretas", "prioridades": ["3 acciones concretas para hoy, la más importante primero"]}.
No inventes números ni hechos: usá solo los datos de arriba.`);
  } catch (e) {
    console.log("Gerente:", e.message);
  }

  const { hora } = horaLocal(c.zona);
  const saludo = hora < "13:00" ? "☀️ ¡Buen día!" : hora < "20:00" ? "👋 ¡Hola!" : "🌙 ¡Buenas noches!";
  return [
    `${saludo} Resumen de ${c.nombre}`,
    charla?.resumen || "",
    espera.length ? `📥 Esperan tu OK: ${espera.join(", ")}` : "📥 No hay nada esperando tu aprobación.",
    hecho.length ? `✅ Últimas 24 h: ${hecho.join(", ")}` : "",
    calientes.length ? `🔥 Leads calientes: ${calientes.map((l) => l.nombre || "@" + l.usuario).join(", ")}` : "",
    urgente.length ? `🔴 Urgente:\n• ${urgente.join("\n• ")}` : "",
    charla?.prioridades?.length ? `🎯 Prioridades de hoy:\n${charla.prioridades.slice(0, 3).map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
    `Panel: ${env.URL_PUBLICA}/panel`,
  ].filter(Boolean).join("\n\n");
}

// Cron: 8:30 de cada cliente, una vez por día.
export async function resumenesDiarios(env) {
  const { results } = await env.DB.prepare("SELECT id, zona FROM clientes WHERE activo = 1").all();
  for (const c of results) {
    const { fecha, hora } = horaLocal(c.zona);
    if (hora < "08:30") continue;
    const clave = `resumen:${c.id}:${fecha}`;
    if (await env.ARCHIVOS.get(clave)) continue;
    await env.ARCHIVOS.put(clave, "1", { expirationTtl: 172800 });
    const texto = await armarResumen(env, c.id);
    for (const chat of await destinatarios(env, c.id)) await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4000), disable_web_page_preview: true });
    return; // uno por pasada
  }
}
