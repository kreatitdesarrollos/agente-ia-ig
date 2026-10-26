// Anuncios de Meta (Marketing API): propuestas de campaña con IA, creación en pausa al aprobar, activar/pausar,
// públicos para retargeting y resultados. La plata nunca se mueve sin dos pasos: aprobar (crea en pausa) y activar.
// El presupuesto diario nunca supera el tope del cliente y toda campaña tiene fecha de fin.

import { gemini, registrar, notificar, destinatarios, tg, cifrar, descifrar, hex } from "./comun.js";

const FB_API = "https://graph.facebook.com/v23.0";

async function fb(env, c, metodo, ruta, datos = {}) {
  const token = await descifrar(env, c.ads_token);
  const url = new URL(`${FB_API}/${ruta}`);
  let cuerpo;
  if (metodo === "GET") {
    for (const [k, v] of Object.entries({ ...datos, access_token: token })) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : v);
  } else {
    cuerpo = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...datos, access_token: token })) cuerpo.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const r = await fetch(url, { method: metodo, body: cuerpo });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.error_user_msg || j.error?.message || JSON.stringify(j));
  return j;
}

export async function guardarAds(env, clienteId, b) {
  const campos = { ads_cuenta: b.cuenta, ads_pagina: b.pagina, ads_link: b.link };
  if (b.cuenta && !/^act_\d+$/.test(b.cuenta)) throw new Error('el ID de la cuenta publicitaria empieza con "act_" seguido de números');
  for (const [campo, valor] of Object.entries(campos)) {
    if (valor !== undefined) await env.DB.prepare(`UPDATE clientes SET ${campo} = ? WHERE id = ?`).bind(String(valor).trim() || null, clienteId).run();
  }
  if (b.tope !== undefined) await env.DB.prepare("UPDATE clientes SET ads_tope_diario = ? WHERE id = ?").bind(Math.max(0, Math.round(Number(b.tope) || 0)), clienteId).run();
  if (b.token) await env.DB.prepare("UPDATE clientes SET ads_token = ? WHERE id = ?").bind(await cifrar(env, b.token.trim()), clienteId).run();
}

export async function probarAds(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c.ads_cuenta || !c.ads_token) return { error: "faltan la cuenta publicitaria o el token" };
  const cuenta = await fb(env, c, "GET", c.ads_cuenta, { fields: "name,currency,account_status" });
  await env.DB.prepare("UPDATE clientes SET ads_moneda = ? WHERE id = ?").bind(cuenta.currency, c.id).run();
  let pagina = null;
  if (c.ads_pagina) pagina = (await fb(env, c, "GET", c.ads_pagina, { fields: "name" })).name;
  const estados = { 1: "activa", 2: "deshabilitada", 3: "con pagos pendientes", 7: "en revisión", 9: "en período de gracia", 101: "cerrada" };
  return { ok: true, cuenta: cuenta.name, moneda: cuenta.currency, estado: estados[cuenta.account_status] || cuenta.account_status, pagina };
}

// ---------------------------------------------------------------- propuesta de campaña

export async function proponerCampana(env, clienteId, idea = "") {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c.ads_cuenta || !c.ads_token) throw new Error("primero conectá la cuenta publicitaria (Clientes → Anuncios de Meta)");
  if (!c.ads_tope_diario) throw new Error("poné un tope de presupuesto diario antes de pedir campañas");
  const { results: posts } = await env.DB.prepare(
    "SELECT media_id, substr(texto, 1, 160) AS texto, alcance, interacciones, guardados, fecha FROM publicaciones_ig " +
    "WHERE cliente_id = ? ORDER BY COALESCE(interacciones, 0) DESC, COALESCE(alcance, 0) DESC, fecha DESC LIMIT 8"
  ).bind(c.id).all();
  if (!posts.length) throw new Error("todavía no hay posts de Instagram sincronizados para promocionar");
  const { results: publicos } = await env.DB.prepare("SELECT tipo FROM audiencias WHERE cliente_id = ?").bind(c.id).all();

  const r = await gemini(env, `${c.marca}

---
Sos el trafficker de ${c.nombre}. Proponé UNA campaña de anuncios en Instagram promocionando uno de sus posts.
${idea ? `Pedido del dueño: "${idea}"\n` : ""}
Posts disponibles (con sus números orgánicos):
${posts.map((p) => `- media_id ${p.media_id} | alcance ${p.alcance ?? "?"} | interacciones ${p.interacciones ?? "?"} | "${(p.texto || "").replace(/\n/g, " ")}"`).join("\n")}

Presupuesto: moneda ${c.ads_moneda || "de la cuenta"}, tope diario ${c.ads_tope_diario}. Link de destino por defecto: ${c.ads_link || "(ninguno)"}.
Públicos guardados: ${publicos.map((p) => p.tipo).join(", ") || "ninguno"}.

Respondé SOLO con un JSON:
- "nombre": nombre corto de la campaña
- "media_id": el del post elegido (de la lista)
- "objetivo": "interaccion" (más alcance e interacción con el post) o "trafico" (llevar gente al link)
- "publico": "amplio"${publicos.some((p) => p.tipo === "interactuaron") ? ' | "interactuaron"' : ""}${publicos.some((p) => p.tipo === "leads") ? ' | "leads"' : ""}
- "edad_min", "edad_max": números entre 18 y 65
- "presupuesto_diario": entero, menor o igual al tope (para empezar conviene algo moderado)
- "dias": entre 3 y 14
- "cta": "LEARN_MORE" | "DOWNLOAD" | "SIGN_UP" | "CONTACT_US" (solo para tráfico)
- "motivo": por qué esta campaña, en 2 frases, basado en los números
- "esperado": qué resultado razonable esperar, sin prometer cifras exageradas`);

  r.presupuesto_diario = Math.min(Math.max(1, Math.round(Number(r.presupuesto_diario) || 0)), c.ads_tope_diario);
  r.dias = Math.min(Math.max(3, Math.round(Number(r.dias) || 7)), 14);
  r.edad_min = Math.min(Math.max(18, Number(r.edad_min) || 18), 65);
  r.edad_max = Math.min(Math.max(r.edad_min, Number(r.edad_max) || 65), 65);
  if (!posts.some((p) => p.media_id === String(r.media_id))) r.media_id = posts[0].media_id;
  if (r.objetivo !== "trafico") r.objetivo = "interaccion";
  if (r.objetivo === "trafico" && !c.ads_link) r.objetivo = "interaccion";
  const post = posts.find((p) => p.media_id === String(r.media_id));
  const datos = { ...r, idea, media_id: String(r.media_id), moneda: c.ads_moneda, link: c.ads_link, post: (post?.texto || "").split("\n")[0] };

  const id = `${c.id}-a${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
  await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'anuncio', ?, ?)")
    .bind(id, c.id, `Campaña: ${r.nombre}`, JSON.stringify(datos)).run();
  await registrar(env, c.id, "anuncio", `propuesta: ${r.nombre}`);
  await vistaPreviaAnuncio(env, id);
  return { ok: true, id };
}

export async function vistaPreviaAnuncio(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const d = JSON.parse(p.datos);
  const texto = `📣 ${p.cliente_nombre}: campaña propuesta "${d.nombre}"\n` +
    `Post: "${d.post}"\nObjetivo: ${d.objetivo === "trafico" ? "tráfico a " + d.link : "interacción con el post"}\n` +
    `Público: ${d.publico}, ${d.edad_min}–${d.edad_max} años\nPresupuesto: ${d.presupuesto_diario} ${d.moneda || ""}/día × ${d.dias} días ` +
    `(máximo ${d.presupuesto_diario * d.dias} ${d.moneda || ""})\n\nPor qué: ${d.motivo}\nQué esperar: ${d.esperado}\n\n` +
    `Al aprobar se crea EN PAUSA: no gasta hasta que la actives en el panel → Anuncios.`;
  const botones = { inline_keyboard: [[
    { text: "✅ Crear en pausa", callback_data: "ok:" + id },
    { text: "🔄 Otra", callback_data: "otra:" + id },
    { text: "❌ Descartar", callback_data: "no:" + id },
  ]] };
  for (const chat of await destinatarios(env, p.cliente_id, true)) {
    const m = await tg(env, "sendMessage", { chat_id: chat, text: texto.slice(0, 4096), reply_markup: botones });
    if (m?.result?.message_id) {
      await env.DB.prepare("INSERT OR REPLACE INTO mensajes_tg (chat_id, message_id, propuesta_id) VALUES (?, ?, ?)").bind(chat, m.result.message_id, id).run();
    }
  }
}

// ---------------------------------------------------------------- crear (en pausa), activar, pausar

export async function ejecutarAnuncio(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está creando" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  const creado = {};
  try {
    if (d.presupuesto_diario > c.ads_tope_diario) throw new Error(`el presupuesto (${d.presupuesto_diario}) supera el tope diario del cliente (${c.ads_tope_diario})`);
    const trafico = d.objetivo === "trafico";
    const campana = await fb(env, c, "POST", `${c.ads_cuenta}/campaigns`, {
      name: `${d.nombre} (hub)`, objective: trafico ? "OUTCOME_TRAFFIC" : "OUTCOME_ENGAGEMENT", status: "PAUSED",
      special_ad_categories: [], buying_type: "AUCTION", is_adset_budget_sharing_enabled: false,
    });
    creado.campana = campana.id;

    const publico = d.publico !== "amplio"
      ? await env.DB.prepare("SELECT id FROM audiencias WHERE cliente_id = ? AND tipo = ?").bind(c.id, d.publico).first() : null;
    const fin = new Date(Date.now() + d.dias * 86400000);
    const conjunto = await fb(env, c, "POST", `${c.ads_cuenta}/adsets`, {
      name: `${d.nombre} — conjunto`, campaign_id: campana.id, status: "PAUSED",
      daily_budget: Math.round(d.presupuesto_diario * 100), // la API usa centavos de la moneda de la cuenta
      billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      optimization_goal: trafico ? "LINK_CLICKS" : "POST_ENGAGEMENT",
      ...(trafico ? { destination_type: "WEBSITE" } : { destination_type: "ON_POST" }),
      end_time: Math.floor(fin.getTime() / 1000),
      targeting: {
        geo_locations: { countries: ["AR"] }, age_min: d.edad_min, age_max: d.edad_max,
        publisher_platforms: ["instagram"], instagram_positions: ["stream", "story", "explore", "reels"],
        ...(publico ? { custom_audiences: [{ id: publico.id }] } : {}),
      },
    });
    creado.conjunto = conjunto.id;

    const creatividad = await fb(env, c, "POST", `${c.ads_cuenta}/adcreatives`, {
      name: `${d.nombre} — creatividad`, object_id: c.ads_pagina, instagram_user_id: c.ig_user_id, source_instagram_media_id: d.media_id,
      ...(trafico ? { call_to_action: { type: d.cta || "LEARN_MORE", value: { link: d.link } } } : {}),
    });
    const anuncio = await fb(env, c, "POST", `${c.ads_cuenta}/ads`, {
      name: `${d.nombre} — anuncio`, adset_id: conjunto.id, creative: { creative_id: creatividad.id }, status: "PAUSED",
    });
    creado.anuncio = anuncio.id;

    await env.DB.prepare(
      "INSERT INTO campanas (id, cliente_id, propuesta_id, nombre, objetivo, estado, presupuesto_diario, dias, fin, conjunto_id, anuncio_id) VALUES (?, ?, ?, ?, ?, 'PAUSED', ?, ?, ?, ?, ?)"
    ).bind(campana.id, c.id, id, d.nombre, d.objetivo, d.presupuesto_diario, d.dias, fin.toISOString().slice(0, 19), conjunto.id, anuncio.id).run();
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(creado), id).run();
    await registrar(env, c.id, "anuncio", `creada en pausa: ${d.nombre}`);
    await notificar(env, c.id, `📣 Campaña "${d.nombre}" creada EN PAUSA en ${c.nombre}. Para que empiece: panel → Anuncios → Activar.`);
    return { ok: true, nota: "Creada en pausa. Activala desde la vista Anuncios." };
  } catch (e) {
    // si se creó algo a medias, la campaña queda en pausa en Meta (no gasta); se informa para borrarla o reintentar
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify({ ...creado, error: String(e.message || e) }), id).run();
    await registrar(env, c.id, "error", "crear campaña: " + e.message);
    await notificar(env, c.id, `⚠️ No pude crear la campaña "${d.nombre}" (${c.nombre}): ${e.message}` +
      (creado.campana ? "\nQuedó una campaña incompleta EN PAUSA en el Administrador de anuncios (no gasta); podés borrarla." : ""));
    return { error: String(e.message || e) };
  }
}

export async function cambiarEstadoCampana(env, campanaId, activar) {
  const k = await env.DB.prepare("SELECT * FROM campanas WHERE id = ?").bind(campanaId).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(k.cliente_id).first();
  const estado = activar ? "ACTIVE" : "PAUSED";
  if (activar) { // al activar se prenden también el conjunto y el anuncio (se crearon en pausa)
    await fb(env, c, "POST", k.anuncio_id, { status: "ACTIVE" });
    await fb(env, c, "POST", k.conjunto_id, { status: "ACTIVE" });
  }
  await fb(env, c, "POST", k.id, { status: estado });
  await env.DB.prepare("UPDATE campanas SET estado = ? WHERE id = ?").bind(estado, k.id).run();
  await registrar(env, c.id, "anuncio", `${activar ? "activada" : "pausada"}: ${k.nombre}`);
  return { ok: true };
}

// ---------------------------------------------------------------- resultados (cron: un cliente por pasada, cada 3 h)

export async function sincronizarAdsSiguiente(env) {
  const c = await env.DB.prepare(
    "SELECT * FROM clientes WHERE ads_token IS NOT NULL AND EXISTS (SELECT 1 FROM campanas k WHERE k.cliente_id = clientes.id) " +
    "AND (ads_sincronizado IS NULL OR ads_sincronizado < datetime('now', '-3 hours')) ORDER BY ads_sincronizado IS NOT NULL, ads_sincronizado LIMIT 1"
  ).first();
  if (!c) return;
  await env.DB.prepare("UPDATE clientes SET ads_sincronizado = datetime('now') WHERE id = ?").bind(c.id).run();
  const { results } = await env.DB.prepare("SELECT id FROM campanas WHERE cliente_id = ? AND creado > datetime('now', '-60 days') LIMIT 8").bind(c.id).all();
  for (const k of results) {
    try {
      const info = await fb(env, c, "GET", k.id, { fields: "effective_status" });
      const { data } = await fb(env, c, "GET", `${k.id}/insights`, { fields: "spend,impressions,reach,clicks,actions", date_preset: "maximum" });
      const m = data?.[0] || {};
      const resultados = (m.actions || []).filter((a) => ["post_engagement", "link_click", "landing_page_view", "onsite_conversion.messaging_conversation_started_7d"].includes(a.action_type))
        .map((a) => `${a.action_type}: ${a.value}`).join(", ");
      await env.DB.prepare("UPDATE campanas SET estado = ?, gasto = ?, impresiones = ?, alcance = ?, clics = ?, resultados = ?, metricas_actualizadas = datetime('now') WHERE id = ?")
        .bind(info.effective_status, Number(m.spend || 0), Number(m.impressions || 0), Number(m.reach || 0), Number(m.clicks || 0), resultados, k.id).run();
    } catch (e) {
      await registrar(env, c.id, "error", `resultados de la campaña ${k.id}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- públicos para retargeting

export async function crearPublicoInstagram(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  const existente = await env.DB.prepare("SELECT id FROM audiencias WHERE cliente_id = ? AND tipo = 'interactuaron'").bind(c.id).first();
  if (existente) return { ok: true, nota: "ya existe" };
  const r = await fb(env, c, "POST", `${c.ads_cuenta}/customaudiences`, {
    name: `Interactuaron con @${c.ig_usuario || c.nombre} (365 días) — hub`, prefill: 1,
    rule: { inclusions: { operator: "or", rules: [{
      event_sources: [{ id: c.ig_user_id, type: "ig_business" }], retention_seconds: 31536000,
      filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: "ig_business_profile_all" }] },
    }] } },
  });
  await env.DB.prepare("INSERT INTO audiencias (id, cliente_id, tipo, nombre) VALUES (?, ?, 'interactuaron', ?)").bind(r.id, c.id, "Interactuaron con Instagram").run();
  return { ok: true };
}

// Público con los emails de los leads (se suben cifrados con SHA-256, como pide Meta).
export async function actualizarPublicoLeads(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  let aud = await env.DB.prepare("SELECT id FROM audiencias WHERE cliente_id = ? AND tipo = 'leads'").bind(c.id).first();
  if (!aud) {
    const r = await fb(env, c, "POST", `${c.ads_cuenta}/customaudiences`, {
      name: `Leads de ${c.nombre} — hub`, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY",
      description: "Contactos que llegaron por Instagram o la web (cargados por el hub)",
    });
    await env.DB.prepare("INSERT INTO audiencias (id, cliente_id, tipo, nombre) VALUES (?, ?, 'leads', ?)").bind(r.id, c.id, "Leads").run();
    aud = { id: r.id };
  }
  const { results } = await env.DB.prepare("SELECT DISTINCT lower(trim(email)) AS email FROM contactos WHERE cliente_id = ? AND email IS NOT NULL AND email != ''").bind(c.id).all();
  if (!results.length) return { ok: true, nota: "todavía no hay leads con email" };
  const hashes = [];
  for (const { email } of results) hashes.push(hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email))));
  await fb(env, c, "POST", `${aud.id}/users`, { payload: { schema: "EMAIL_SHA256", data: hashes } });
  await env.DB.prepare("UPDATE audiencias SET actualizado = datetime('now') WHERE id = ?").bind(aud.id).run();
  return { ok: true, nota: `${hashes.length} leads cargados` };
}
