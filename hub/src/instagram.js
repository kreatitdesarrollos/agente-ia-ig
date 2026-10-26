// Estudio de contenido (métricas de cada post) y reputación (comentarios) en Instagram.
//
// Todo corre desde el cron del hub en tandas chicas: el plan gratis de Cloudflare limita cuántas llamadas
// externas puede hacer cada pasada, así que se procesa un cliente y unos pocos posts/comentarios por vez.

import { IG_API, igGet, igPost, gemini, registrar, notificar, destinatarios, tg, descifrar, horaLocal, hex } from "./comun.js";

// ---------------------------------------------------------------- sincronización (posts, métricas, comentarios)

// Un cliente por pasada: el que hace más tiempo que no se sincroniza (como mucho cada 15 minutos).
export async function sincronizarSiguiente(env) {
  const c = await env.DB.prepare(
    "SELECT * FROM clientes WHERE activo = 1 AND ig_token IS NOT NULL AND ig_user_id IS NOT NULL " +
    "AND (ig_sincronizado IS NULL OR ig_sincronizado < datetime('now', '-15 minutes')) " +
    "ORDER BY ig_sincronizado IS NOT NULL, ig_sincronizado LIMIT 1"
  ).first();
  if (!c) return;
  await env.DB.prepare("UPDATE clientes SET ig_sincronizado = datetime('now') WHERE id = ?").bind(c.id).run();
  try {
    await sincronizar(env, c);
  } catch (e) {
    await registrar(env, c.id, "error", "sincronizar Instagram: " + e.message);
  }
}

async function sincronizar(env, c) {
  const token = await descifrar(env, c.ig_token);
  if (!c.ig_usuario) {
    c.ig_usuario = (await igGet(`${IG_API}/me`, { fields: "username", access_token: token })).username;
    await env.DB.prepare("UPDATE clientes SET ig_usuario = ? WHERE id = ?").bind(c.ig_usuario, c.id).run();
  }

  const { data } = await igGet(`${IG_API}/${c.ig_user_id}/media`, {
    fields: "id,caption,timestamp,permalink,like_count,comments_count", limit: "25", access_token: token,
  });
  for (const m of data) {
    await env.DB.prepare(
      "INSERT INTO publicaciones_ig (media_id, cliente_id, propuesta_id, texto, fecha, enlace, me_gusta, comentarios) " +
      "VALUES (?, ?, (SELECT id FROM propuestas WHERE json_extract(resultado, '$.media_id') = ?), ?, ?, ?, ?, ?) " +
      "ON CONFLICT(media_id) DO UPDATE SET me_gusta = excluded.me_gusta, comentarios = excluded.comentarios, " +
      "texto = excluded.texto, enlace = excluded.enlace"
    ).bind(m.id, c.id, m.id, (m.caption || "").slice(0, 2000), m.timestamp, m.permalink, m.like_count || 0, m.comments_count || 0).run();
  }

  // métricas: hasta 5 posts por pasada, de los últimos 60 días, los que hace más tiempo que no se miden
  const { results: medir } = await env.DB.prepare(
    "SELECT media_id FROM publicaciones_ig WHERE cliente_id = ? AND fecha > ? " +
    "AND (metricas_actualizadas IS NULL OR metricas_actualizadas < datetime('now', '-6 hours')) " +
    "ORDER BY metricas_actualizadas IS NOT NULL, metricas_actualizadas LIMIT 5"
  ).bind(c.id, haceDias(60)).all();
  for (const { media_id } of medir) {
    let v = {};
    try {
      const { data: metricas } = await igGet(`${IG_API}/${media_id}/insights`, {
        metric: "reach,saved,shares,total_interactions", access_token: token,
      });
      v = Object.fromEntries(metricas.map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? 0]));
    } catch (e) {
      console.log("métricas", media_id, e.message);
    }
    await env.DB.prepare(
      "UPDATE publicaciones_ig SET alcance = ?, guardados = ?, compartidos = ?, interacciones = ?, metricas_actualizadas = datetime('now') WHERE media_id = ?"
    ).bind(v.reach ?? null, v.saved ?? null, v.shares ?? null, v.total_interactions ?? null, media_id).run();
  }

  // comentarios nuevos: posts con más comentarios que los ya vistos (hasta 4 posts por pasada).
  // La primera vez que se sincroniza un cliente, los comentarios viejos quedan como "ignorados".
  const estadoInicial = c.ig_sincronizado ? "nuevo" : "ignorado";
  const { results: conNuevos } = await env.DB.prepare(
    "SELECT media_id, comentarios FROM publicaciones_ig WHERE cliente_id = ? AND comentarios > comentarios_vistos ORDER BY fecha DESC LIMIT 4"
  ).bind(c.id).all();
  for (const p of conNuevos) {
    const { data: comentarios } = await igGet(`${IG_API}/${p.media_id}/comments`, {
      fields: "id,text,username,timestamp", limit: "50", access_token: token,
    });
    for (const co of comentarios) {
      if (co.username === c.ig_usuario) continue; // los de la propia cuenta
      await env.DB.prepare(
        "INSERT OR IGNORE INTO comentarios (id, cliente_id, media_id, usuario, texto, fecha, estado) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(co.id, c.id, p.media_id, co.username, co.text, co.timestamp, estadoInicial).run();
    }
    await env.DB.prepare("UPDATE publicaciones_ig SET comentarios_vistos = ? WHERE media_id = ?").bind(p.comentarios, p.media_id).run();
  }
}

function haceDias(dias) {
  return new Date(Date.now() - dias * 86400000).toISOString().slice(0, 19);
}

// ---------------------------------------------------------------- respuestas a comentarios

// Hasta 3 comentarios nuevos por pasada: Gemini los clasifica y propone qué hacer.
export async function proponerRespuestas(env) {
  const { results } = await env.DB.prepare(
    "SELECT co.*, c.nombre, c.marca, p.texto AS post FROM comentarios co JOIN clientes c ON c.id = co.cliente_id " +
    "LEFT JOIN publicaciones_ig p ON p.media_id = co.media_id WHERE co.estado = 'nuevo' ORDER BY co.fecha LIMIT 3"
  ).all();
  for (const co of results) {
    let r;
    try {
      r = await gemini(env, `${co.marca}

---
Sos el community manager de ${co.nombre}. Llegó este comentario en Instagram.
Post: "${(co.post || "").slice(0, 700)}"
Comentario de @${co.usuario}: "${co.texto}"

Respondé SOLO con un JSON con estas claves:
- "categoria": "pregunta" | "elogio" | "queja" | "compra" | "spam" | "otro"
- "accion": "responder" | "ocultar" | "ignorar"
- "respuesta": el texto para responder (vacío si la acción no es responder)
- "urgente": true si es una queja, un problema con el servicio o algo que el dueño tiene que ver ya

Reglas:
- Respuesta corta (1 a 3 frases), cálida, en el tono de la marca, en español como habla el público.
- Si pregunta algo que no está en la info de la marca, no inventes: invitá a escribir por mensaje directo.
- Si es una consulta de compra, respondé y llevalo a la acción que pide la marca (mensaje directo, WhatsApp, descargar la app...).
- Si es spam, estafa, publicidad ajena u ofensivo: "ocultar".
- Si solo etiqueta a otra persona o son emojis sueltos: respondé muy breve y amable, o "ignorar" si no aporta.
- No uses hashtags ni markdown.`);
    } catch (e) {
      console.log("Gemini comentarios:", e.message);
      return; // se reintenta en la próxima pasada
    }
    if (r.accion === "ignorar") {
      await env.DB.prepare("UPDATE comentarios SET estado = 'ignorado', categoria = ? WHERE id = ?").bind(r.categoria, co.id).run();
      continue;
    }
    const id = `${co.cliente_id}-r${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
    const datos = {
      comentario_id: co.id, comentario: co.texto, usuario: co.usuario, post: (co.post || "").slice(0, 200),
      respuesta: r.respuesta || "", accion: r.accion === "ocultar" ? "ocultar" : "responder", categoria: r.categoria, urgente: !!r.urgente,
    };
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'respuesta', ?, ?)")
      .bind(id, co.cliente_id, `Comentario de @${co.usuario}`, JSON.stringify(datos)).run();
    await env.DB.prepare("UPDATE comentarios SET estado = 'propuesto', categoria = ? WHERE id = ?").bind(r.categoria, co.id).run();
    await registrar(env, co.cliente_id, "comentario", `${r.categoria}: @${co.usuario} "${co.texto}"`);
    await vistaPreviaRespuesta(env, id);
  }
}

const ICONOS = { pregunta: "❓", elogio: "💜", queja: "⚠️", compra: "🛒", spam: "🚫", otro: "💬" };

export async function vistaPreviaRespuesta(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const d = JSON.parse(p.datos);
  const ocultar = d.accion === "ocultar";
  const texto = `${d.urgente ? "🔴 URGENTE — " : ""}${ICONOS[d.categoria] || "💬"} ${p.cliente_nombre}: @${d.usuario} comentó` +
    (d.post ? ` en "${d.post.split("\n")[0].slice(0, 80)}"` : "") + `:\n«${d.comentario}»\n\n` +
    (ocultar ? "Sugerencia: ocultar este comentario (parece spam u ofensivo)." : `Respuesta sugerida:\n${d.respuesta}\n\n— Respondé a este mensaje con otro texto para cambiar la respuesta.`);
  const botones = { inline_keyboard: [[
    { text: ocultar ? "🙈 Ocultar" : "✅ Responder", callback_data: "ok:" + id },
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

// Ejecuta una respuesta aprobada: responde u oculta el comentario en Instagram.
export async function ejecutarRespuesta(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está procesando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  const resultado = {};
  try {
    const token = await descifrar(env, c.ig_token);
    if (d.accion === "ocultar") {
      await igPost(`${IG_API}/${d.comentario_id}`, { hide: "true", access_token: token });
      await env.DB.prepare("UPDATE comentarios SET estado = 'oculto' WHERE id = ?").bind(d.comentario_id).run();
    } else {
      const r = await igPost(`${IG_API}/${d.comentario_id}/replies`, { message: d.respuesta, access_token: token });
      resultado.respuesta_id = r.id;
      await env.DB.prepare("UPDATE comentarios SET estado = 'respondido' WHERE id = ?").bind(d.comentario_id).run();
    }
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, d.accion === "ocultar" ? "oculto" : "respondido", `@${d.usuario}: ${d.respuesta || d.comentario}`);
    await notificar(env, c.id, d.accion === "ocultar" ? `🙈 Comentario de @${d.usuario} ocultado en ${c.nombre}.` : `💬 Respondido a @${d.usuario} en ${c.nombre}.`);
    return { ok: true };
  } catch (e) {
    resultado.error = String(e.message || e);
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(resultado), id).run();
    await registrar(env, c.id, "error", "responder comentario: " + resultado.error);
    await notificar(env, c.id, `⚠️ No pude responder a @${d.usuario} en ${c.nombre}: ${resultado.error}`);
    return { error: resultado.error };
  }
}

// ---------------------------------------------------------------- estudio de contenido

// Lo que el generador tiene que saber para escribir mejor: qué funcionó, qué no y la última recomendación.
export async function aprendizajes(env, clienteId) {
  const consulta = (orden) => env.DB.prepare(
    "SELECT texto, alcance, interacciones, guardados, compartidos FROM publicaciones_ig " +
    `WHERE cliente_id = ? AND interacciones IS NOT NULL AND fecha > ? ORDER BY interacciones ${orden}, alcance ${orden} LIMIT ?`
  );
  const mejores = (await consulta("DESC").bind(clienteId, haceDias(90), 5).all()).results;
  const peores = (await consulta("ASC").bind(clienteId, haceDias(90), 3).all()).results;
  const informe = await env.DB.prepare("SELECT texto FROM informes WHERE cliente_id = ? ORDER BY id DESC LIMIT 1").bind(clienteId).first();
  const linea = (p) => ({ texto: (p.texto || "").split("\n")[0].slice(0, 140), alcance: p.alcance, interacciones: p.interacciones, guardados: p.guardados });
  return { mejores: mejores.map(linea), peores: peores.length >= 3 ? peores.map(linea) : [], recomendaciones: informe?.texto || "" };
}

// Informe semanal: los lunes desde las 9:30 (hora del cliente). Uno por pasada.
export async function informesSemanales(env) {
  const { results } = await env.DB.prepare("SELECT * FROM clientes WHERE activo = 1 AND ig_token IS NOT NULL").all();
  for (const c of results) {
    const { fecha, hora } = horaLocal(c.zona);
    const dia = new Intl.DateTimeFormat("en-US", { timeZone: c.zona, weekday: "short" }).format(new Date());
    if (dia !== "Mon" || hora < "09:30" || c.ultimo_informe === fecha) continue;
    await env.DB.prepare("UPDATE clientes SET ultimo_informe = ? WHERE id = ?").bind(fecha, c.id).run();
    await generarInforme(env, c);
    return;
  }
}

export async function generarInforme(env, c) {
  const semana = (await env.DB.prepare("SELECT * FROM publicaciones_ig WHERE cliente_id = ? AND fecha > ? ORDER BY interacciones DESC")
    .bind(c.id, haceDias(7)).all()).results;
  const mes = (await env.DB.prepare("SELECT * FROM publicaciones_ig WHERE cliente_id = ? AND fecha > ? ORDER BY interacciones DESC")
    .bind(c.id, haceDias(30)).all()).results;
  const cats = (await env.DB.prepare("SELECT categoria, COUNT(*) AS n FROM comentarios WHERE cliente_id = ? AND fecha > ? GROUP BY categoria")
    .bind(c.id, haceDias(7)).all()).results;
  const suma = (lista, campo) => lista.reduce((t, p) => t + (p[campo] || 0), 0);
  const prom = (lista, campo) => (lista.length ? Math.round(suma(lista, campo) / lista.length) : 0);
  const titulo = (p) => (p.texto || "").split("\n")[0].slice(0, 70) || "(sin texto)";

  let texto = `Últimos 7 días: ${semana.length} posts · alcance ${suma(semana, "alcance")} · interacciones ${suma(semana, "interacciones")}` +
    ` · guardados ${suma(semana, "guardados")}\nPromedio por post (30 días): alcance ${prom(mes, "alcance")}, interacciones ${prom(mes, "interacciones")}` +
    (semana.length ? `\nMejor de la semana: "${titulo(semana[0])}" (${semana[0].interacciones ?? 0} interacciones, alcance ${semana[0].alcance ?? 0})` : "") +
    (cats.length ? `\nComentarios: ${cats.map((x) => `${x.n} ${x.categoria || "sin clasificar"}`).join(", ")}` : "");

  try {
    const r = await gemini(env, `${c.marca}

---
Sos el analista de redes de ${c.nombre}. Estos son los posts de Instagram de los últimos 30 días con sus números
(alcance = cuentas que lo vieron; interacciones = me gusta + comentarios + guardados + compartidos):
${mes.map((p) => `- ${p.fecha?.slice(0, 10)} | alcance ${p.alcance ?? "?"} | interacciones ${p.interacciones ?? "?"} | guardados ${p.guardados ?? "?"} | "${titulo(p)}"`).join("\n") || "(todavía no hay posts con métricas)"}

Respondé SOLO con un JSON: {"recomendaciones": ["...", "...", "..."]}
Tres recomendaciones concretas y accionables para la semana que viene (qué temas, ganchos o formatos repetir o evitar),
basadas en los números. Si hay pocos datos, decilo y recomendá qué probar. Una o dos frases cada una, sin markdown.`);
    if (r.recomendaciones?.length) texto += "\n\nRecomendaciones:\n" + r.recomendaciones.map((x, i) => `${i + 1}. ${x}`).join("\n");
  } catch (e) {
    console.log("Gemini informe:", e.message);
  }
  await env.DB.prepare("INSERT INTO informes (cliente_id, texto) VALUES (?, ?)").bind(c.id, texto).run();
  await notificar(env, c.id, `📊 Informe semanal de ${c.nombre}\n\n${texto}\n\nMás detalle en el panel → Resultados.`);
  return texto;
}
