// Prospección en frío (B2B): campañas por rubro y zona, prospectos (de OpenStreetMap o CSV), propuestas
// personalizadas que se aprueban por tandas, envío a ritmo humano desde una casilla aparte del cliente,
// seguimientos en el mismo hilo y lectura de respuestas. El trabajo pesado lo hace prospector.py (GitHub Actions).

import { registrar, destinatarios, tg, cifrar, descifrar, hex, horaLocal, despacharWorkflow, responder } from "./comun.js";

// ---------------------------------------------------------------- API para prospector.py

export async function apiProspector(req, env, ruta, url) {
  const json = (d, s = 200) => Response.json(d, { status: s });

  if (ruta === "trabajo") {
    const c = await env.DB.prepare("SELECT id, nombre, marca FROM clientes WHERE id = ?").bind(url.searchParams.get("cliente")).first();
    const p = await env.DB.prepare("SELECT * FROM prospecciones WHERE id = ? AND cliente_id = ?").bind(url.searchParams.get("prospeccion"), c?.id).first();
    if (!c || !p) return json({ error: "no existe" }, 404);
    const conocidos = (await env.DB.prepare("SELECT email FROM prospectos WHERE cliente_id = ? UNION SELECT email FROM bajas_frio WHERE cliente_id = ?").bind(c.id, c.id).all()).results.map((x) => x.email);
    return json({ cliente: c, prospeccion: p, conocidos });
  }

  // prospectos encontrados (o del CSV): entran como "nuevo"
  if (ruta === "prospectos" && req.method === "POST") {
    const b = await req.json();
    let nuevos = 0;
    for (const x of b.prospectos || []) {
      const email = String(x.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
      if (await env.DB.prepare("SELECT 1 FROM bajas_frio WHERE cliente_id = ? AND email = ?").bind(b.cliente_id, email).first()) continue;
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO prospectos (id, cliente_id, prospeccion_id, nombre, email, web, telefono, ciudad, fuente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("pr-" + hex(crypto.getRandomValues(new Uint8Array(6))), b.cliente_id, b.prospeccion_id, x.nombre || null, email, x.web || null, x.telefono || null, x.ciudad || null, x.fuente || "csv").run();
      nuevos += r.meta.changes;
    }
    await registrar(env, b.cliente_id, "prospeccion", `${nuevos} prospectos nuevos`);
    return json({ ok: true, nuevos });
  }

  // los que falta escribir
  if (ruta === "nuevos") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM prospectos WHERE cliente_id = ? AND prospeccion_id = ? AND estado = 'nuevo' ORDER BY creado LIMIT ?"
    ).bind(url.searchParams.get("cliente"), url.searchParams.get("prospeccion"), Number(url.searchParams.get("limite") || 15)).all();
    return json(results);
  }

  // propuestas escritas por la IA: van a la fila de aprobación y llega un solo aviso por tanda
  if (ruta === "propuestas" && req.method === "POST") {
    const b = await req.json();
    const p = await env.DB.prepare("SELECT * FROM prospecciones WHERE id = ?").bind(b.prospeccion_id).first();
    let n = 0;
    for (const x of b.propuestas || []) {
      const pr = await env.DB.prepare("SELECT * FROM prospectos WHERE id = ? AND estado = 'nuevo'").bind(x.prospecto_id).first();
      if (!pr) continue;
      if (x.descartar) {
        await env.DB.prepare("UPDATE prospectos SET estado = 'descartado', resumen = ? WHERE id = ?").bind(x.resumen || x.motivo || null, pr.id).run();
        continue;
      }
      const id = `${pr.cliente_id}-f${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
      const datos = { prospecto_id: pr.id, prospeccion_id: p.id, campana: p.nombre, nombre: pr.nombre, email: pr.email, web: pr.web, resumen: x.resumen, asunto: x.asunto, cuerpo: x.cuerpo };
      await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'prospecto', ?, ?)")
        .bind(id, pr.cliente_id, `Propuesta a ${pr.nombre || pr.email}`, JSON.stringify(datos)).run();
      await env.DB.prepare("UPDATE prospectos SET estado = 'propuesto', resumen = ?, asunto = ? WHERE id = ?").bind(x.resumen || null, x.asunto, pr.id).run();
      n++;
    }
    if (n) {
      const botones = { inline_keyboard: [[{ text: `✅ Aprobar las ${n}`, callback_data: "lote:" + p.id }, { text: "👀 Revisar en el panel", url: `${env.URL_PUBLICA}/panel` }]] };
      for (const chat of await destinatarios(env, p.cliente_id, true)) {
        await tg(env, "sendMessage", { chat_id: chat, text: `📨 ${n} propuestas nuevas de la campaña "${p.nombre}" listas para revisar.\nEstán en el panel → Para aprobar (podés editarlas). Si confiás en la tanda, aprobala entera acá.`, reply_markup: botones });
      }
    }
    return json({ ok: true, n });
  }

  // lo que hay que mandar hoy: primeros emails aprobados y seguimientos vencidos, respetando el tope diario
  if (ruta === "envios") {
    const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(url.searchParams.get("cliente")).first();
    if (!c?.prospeccion_correo) return json({ error: "el cliente no tiene casilla de prospección configurada" }, 400);
    const correo = JSON.parse(await descifrar(env, c.prospeccion_correo));
    const cola = [];
    const { results: campanas } = await env.DB.prepare("SELECT * FROM prospecciones WHERE cliente_id = ? AND activa = 1").bind(c.id).all();
    for (const p of campanas) {
      const hoy = (await env.DB.prepare(
        "SELECT COUNT(*) n FROM envios_frio e JOIN prospectos x ON x.id = e.prospecto_id WHERE x.prospeccion_id = ? AND e.fecha > datetime('now', 'start of day')"
      ).bind(p.id).first()).n;
      let cupo = Math.max(0, p.por_dia - hoy);
      const seg = JSON.parse(p.seguimientos || "[]");
      const { results: seguimientos } = await env.DB.prepare(
        "SELECT * FROM prospectos WHERE prospeccion_id = ? AND estado = 'enviado' AND proximo <= datetime('now') AND paso < ? ORDER BY proximo LIMIT ?"
      ).bind(p.id, seg.length, cupo).all();
      for (const x of seguimientos) {
        const previo = await env.DB.prepare("SELECT cuerpo FROM envios_frio WHERE prospecto_id = ? ORDER BY id DESC LIMIT 1").bind(x.id).first();
        cola.push({ ...x, paso: x.paso + 1, campana: p.nombre, oferta: p.oferta, link: p.link, anterior: previo?.cuerpo || "", baja: await linkBaja(env, x) });
      }
      cupo -= seguimientos.length;
      const { results: primeros } = await env.DB.prepare(
        "SELECT x.*, json_extract(pp.datos, '$.cuerpo') AS cuerpo, json_extract(pp.datos, '$.asunto') AS asunto_aprobado FROM prospectos x " +
        "JOIN propuestas pp ON pp.tipo = 'prospecto' AND json_extract(pp.datos, '$.prospecto_id') = x.id AND pp.estado = 'publicada' " +
        "WHERE x.prospeccion_id = ? AND x.estado = 'aprobado' ORDER BY x.creado LIMIT ?"
      ).bind(p.id, cupo).all();
      for (const x of primeros) cola.push({ ...x, paso: 0, asunto: x.asunto_aprobado, campana: p.nombre, baja: await linkBaja(env, x) });
    }
    const { results: enviados } = await env.DB.prepare(
      "SELECT id, email, message_id FROM prospectos WHERE cliente_id = ? AND message_id IS NOT NULL AND estado IN ('enviado', 'terminado')"
    ).bind(c.id).all();
    return json({ cliente: { id: c.id, nombre: c.nombre, marca: c.marca }, correo, cola, enviados });
  }

  if (ruta === "enviado" && req.method === "POST") {
    const b = await req.json();
    const x = await env.DB.prepare("SELECT x.*, p.seguimientos FROM prospectos x JOIN prospecciones p ON p.id = x.prospeccion_id WHERE x.id = ?").bind(b.prospecto_id).first();
    if (!x) return json({ error: "no existe" }, 404);
    await env.DB.prepare("INSERT INTO envios_frio (cliente_id, prospecto_id, paso, asunto, cuerpo, message_id, estado, detalle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(x.cliente_id, x.id, b.paso, b.asunto, b.cuerpo, b.message_id || null, b.ok ? "enviado" : "error", b.detalle || null).run();
    if (!b.ok) {
      if (b.rechazado) await marcarBaja(env, x.cliente_id, x.email, "rebote", x.id);
      return json({ ok: true });
    }
    const seg = JSON.parse(x.seguimientos || "[]");
    const siguiente = seg[b.paso]; // días desde el primer email hasta el próximo seguimiento
    const proximo = siguiente !== undefined ? `datetime('now', '+${Number(siguiente) - (b.paso ? Number(seg[b.paso - 1]) : 0)} days')` : null;
    await env.DB.prepare(
      `UPDATE prospectos SET paso = ?, estado = ?, ultimo_envio = datetime('now'), proximo = ${proximo || "NULL"}` +
      (b.paso === 0 ? ", message_id = ?, asunto = ?" : "") + " WHERE id = ?"
    ).bind(b.paso, proximo ? "enviado" : "terminado", ...(b.paso === 0 ? [b.message_id, b.asunto] : []), x.id).run();
    return json({ ok: true });
  }

  // respuestas, rebotes y bajas que encontró al leer la casilla
  if (ruta === "respuestas" && req.method === "POST") {
    const b = await req.json();
    for (const ev of b.eventos || []) {
      const x = await env.DB.prepare("SELECT * FROM prospectos WHERE cliente_id = ? AND email = ?").bind(b.cliente_id, String(ev.email).toLowerCase()).first();
      if (!x || ["respondio", "baja", "rebote"].includes(x.estado)) continue;
      if (ev.tipo === "rebote" || ev.tipo === "baja") {
        await marcarBaja(env, x.cliente_id, x.email, ev.tipo, x.id);
        continue;
      }
      await env.DB.prepare("UPDATE prospectos SET estado = 'respondio', proximo = NULL WHERE id = ?").bind(x.id).run();
      const contacto = "ct-" + hex(crypto.getRandomValues(new Uint8Array(6)));
      await env.DB.prepare(
        "INSERT INTO contactos (id, cliente_id, canal, externo_id, nombre, email, telefono, etapa, resumen, ultimo_mensaje) VALUES (?, ?, 'email', ?, ?, ?, ?, 'conversando', ?, datetime('now'))"
      ).bind(contacto, x.cliente_id, x.email, x.nombre, x.email, x.telefono, `Respondió la prospección (${x.resumen || x.web || ""})`.slice(0, 300)).run();
      await env.DB.prepare("INSERT OR IGNORE INTO mensajes (id, cliente_id, contacto_id, direccion, texto) VALUES (?, ?, ?, 'entrante', ?)")
        .bind("frio-" + x.id, x.cliente_id, contacto, String(ev.texto || "").slice(0, 3000)).run();
      await registrar(env, x.cliente_id, "lead", `respondió la prospección: ${x.nombre || x.email}`);
      for (const chat of await destinatarios(env, x.cliente_id)) {
        await tg(env, "sendMessage", { chat_id: chat, text: `📩 ¡${x.nombre || x.email} respondió tu propuesta!\n«${String(ev.texto || "").slice(0, 700)}»\n\nRespondele desde tu casilla. Ya quedó como lead en el panel.` });
      }
    }
    return json({ ok: true });
  }

  return json({ error: "no existe" }, 404);
}

async function marcarBaja(env, clienteId, email, motivo, prospectoId) {
  await env.DB.prepare("INSERT OR IGNORE INTO bajas_frio (cliente_id, email, motivo) VALUES (?, ?, ?)").bind(clienteId, email, motivo).run();
  await env.DB.prepare("UPDATE prospectos SET estado = ?, proximo = NULL WHERE id = ?").bind(motivo === "rebote" ? "rebote" : "baja", prospectoId).run();
}

// ---------------------------------------------------------------- baja (link en cada email)

async function firma(env, texto) {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CLAVE_CIFRADO), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode("frio:" + texto))).slice(0, 24);
}

async function linkBaja(env, x) {
  return `${env.URL_PUBLICA}/baja-frio/${x.id}.${await firma(env, x.id)}`;
}

export async function paginaBajaFrio(env, token) {
  const [id, f] = token.split(".");
  const pagina = (t) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Baja</title>` +
    `<body style="font:17px system-ui;text-align:center;padding:15vh 16px"><p>${t}</p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (!id || f !== (await firma(env, id))) return pagina("El link no es válido.");
  const x = await env.DB.prepare("SELECT * FROM prospectos WHERE id = ?").bind(id).first();
  if (!x) return pagina("El link no es válido.");
  await marcarBaja(env, x.cliente_id, x.email, "baja", x.id);
  await registrar(env, x.cliente_id, "baja", `${x.email} pidió no recibir más emails de prospección`);
  return pagina("Listo: no te vamos a volver a escribir. Disculpá la molestia.");
}

// ---------------------------------------------------------------- aprobación

export async function aprobarLote(env, prospeccionId) {
  const { results } = await env.DB.prepare(
    "SELECT id, datos FROM propuestas WHERE tipo = 'prospecto' AND estado = 'pendiente' AND json_extract(datos, '$.prospeccion_id') = ?"
  ).bind(prospeccionId).all();
  for (const p of results) await aprobarProspecto(env, p.id, JSON.parse(p.datos));
  const pr = await env.DB.prepare("SELECT cliente_id FROM prospecciones WHERE id = ?").bind(prospeccionId).first();
  if (results.length && pr) await despacharWorkflow(env, "prospectar.yml", { cliente: pr.cliente_id, accion: "ciclo", prospeccion: "" });
  return { ok: true, n: results.length };
}

// Aprobar una propuesta de prospección la deja en la cola de envío (sale con el ritmo y el tope del día).
export async function aprobarProspecto(env, propuestaId, datos) {
  await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', actualizado = datetime('now') WHERE id = ?").bind(propuestaId).run();
  await env.DB.prepare("UPDATE prospectos SET estado = 'aprobado' WHERE id = ? AND estado = 'propuesto'").bind(datos.prospecto_id).run();
  return { ok: true, nota: "Aprobada: sale en la próxima tanda de envíos (respetando el tope diario)" };
}

export async function ejecutarProspecto(env, id) {
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const r = await aprobarProspecto(env, id, JSON.parse(p.datos));
  await despacharWorkflow(env, "prospectar.yml", { cliente: p.cliente_id, accion: "ciclo", prospeccion: "" });
  return r;
}

// ---------------------------------------------------------------- cron: dos tandas por día hábil (10 y 16 h del cliente)

export async function prospeccionProgramada(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM clientes WHERE activo = 1 AND prospeccion_correo IS NOT NULL AND EXISTS (SELECT 1 FROM prospecciones p WHERE p.cliente_id = clientes.id AND p.activa = 1)"
  ).all();
  for (const c of results) {
    const { fecha, hora } = horaLocal(c.zona);
    const dia = new Intl.DateTimeFormat("en-US", { timeZone: c.zona, weekday: "short" }).format(new Date());
    if (["Sat", "Sun"].includes(dia)) continue;
    const turno = hora >= "16:00" ? "tarde" : hora >= "10:00" ? "manana" : null;
    if (!turno) continue;
    const clave = `frio:${c.id}:${fecha}:${turno}`;
    if (await env.ARCHIVOS.get(clave)) continue;
    await env.ARCHIVOS.put(clave, "1", { expirationTtl: 172800 });
    await despacharWorkflow(env, "prospectar.yml", { cliente: c.id, accion: "ciclo", prospeccion: "" });
    return; // uno por pasada
  }
}

// ---------------------------------------------------------------- panel

export async function apiPanelProspeccion(req, env, yo, puede, ruta, url) {
  const json = (d, s = 200) => Response.json(d, { status: s });
  const metodo = req.method;
  const NO = () => json({ error: "no tenés acceso a ese cliente" }, 403);

  if (ruta === "prospeccion" && metodo === "GET") {
    const cliente = url.searchParams.get("cliente");
    if (!puede(yo, cliente)) return NO();
    const c = await env.DB.prepare("SELECT prospeccion_correo IS NOT NULL AS casilla FROM clientes WHERE id = ?").bind(cliente).first();
    const { results } = await env.DB.prepare(
      "SELECT p.*, (SELECT json_group_object(estado, n) FROM (SELECT estado, COUNT(*) n FROM prospectos x WHERE x.prospeccion_id = p.id GROUP BY estado)) AS conteo " +
      "FROM prospecciones p WHERE p.cliente_id = ? ORDER BY p.creado DESC"
    ).bind(cliente).all();
    return json({ casilla: !!c?.casilla, campanas: results.map((p) => ({ ...p, conteo: JSON.parse(p.conteo || "{}") })) });
  }
  if (ruta === "prospeccion" && metodo === "POST") {
    const b = await req.json();
    if (!puede(yo, b.cliente)) return NO();
    if (!b.nombre || !b.oferta) return json({ error: "faltan el nombre o la oferta" }, 400);
    const id = "pc-" + hex(crypto.getRandomValues(new Uint8Array(5)));
    await env.DB.prepare("INSERT INTO prospecciones (id, cliente_id, nombre, rubro, zona, oferta, link, por_dia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, b.cliente, b.nombre, b.rubro || null, b.zona || null, b.oferta, b.link || null, Math.min(40, Math.max(1, Number(b.por_dia) || 15))).run();
    return json({ ok: true, id });
  }
  const pc = ruta.match(/^prospeccion\/(pc-[\w]+)(?:\/(buscar|csv|prospectos|activa|aprobar))?$/);
  if (pc) {
    const p = await env.DB.prepare("SELECT * FROM prospecciones WHERE id = ?").bind(pc[1]).first();
    if (!p || !puede(yo, p.cliente_id)) return NO();
    if (pc[2] === "buscar" && metodo === "POST") {
      const b = await req.json();
      await registrar(env, p.cliente_id, "prospeccion", `buscando ${p.rubro} en ${p.zona}`);
      await despacharWorkflow(env, "prospectar.yml", { cliente: p.cliente_id, accion: "buscar", prospeccion: p.id, cantidad: String(Math.min(50, Math.max(5, Number(b.cantidad) || 20))) });
      return json({ ok: true });
    }
    if (pc[2] === "csv" && metodo === "POST") {
      const b = await req.json();
      const r = await apiProspector(new Request("https://x/", { method: "POST", body: JSON.stringify({ cliente_id: p.cliente_id, prospeccion_id: p.id, prospectos: (b.filas || []).slice(0, 500).map((f) => ({ ...f, fuente: "csv" })) }) }), env, "prospectos", url);
      const { nuevos } = await r.json();
      if (nuevos) await despacharWorkflow(env, "prospectar.yml", { cliente: p.cliente_id, accion: "escribir", prospeccion: p.id });
      return json({ ok: true, nuevos });
    }
    if (pc[2] === "prospectos") {
      const { results } = await env.DB.prepare("SELECT * FROM prospectos WHERE prospeccion_id = ? ORDER BY creado DESC LIMIT 300").bind(p.id).all();
      return json(results);
    }
    if (pc[2] === "activa" && metodo === "POST") {
      await env.DB.prepare("UPDATE prospecciones SET activa = 1 - activa WHERE id = ?").bind(p.id).run();
      return json({ ok: true });
    }
    if (pc[2] === "aprobar" && metodo === "POST") return json(await aprobarLote(env, p.id));
  }
  const cf = ruta.match(/^clientes\/([\w-]+)\/correo-frio(\/probar)?$/);
  if (cf && metodo === "POST") {
    if (!puede(yo, cf[1])) return NO();
    if (cf[2]) {
      await despacharWorkflow(env, "prospectar.yml", { cliente: cf[1], accion: "probar", prospeccion: "" });
      return json({ ok: true, nota: "Probando la casilla: en 1 minuto te llega el resultado por Telegram" });
    }
    const b = await req.json();
    for (const k of ["usuario", "clave", "smtp_host", "imap_host"]) if (!b[k]) return json({ error: "falta " + k }, 400);
    const correo = { usuario: b.usuario.trim(), clave: b.clave, smtp_host: b.smtp_host.trim(), smtp_puerto: Number(b.smtp_puerto) || 465,
      imap_host: b.imap_host.trim(), remitente: (b.remitente || "").trim(), firma: (b.firma || "").trim() };
    await env.DB.prepare("UPDATE clientes SET prospeccion_correo = ? WHERE id = ?").bind(await cifrar(env, JSON.stringify(correo)), cf[1]).run();
    return json({ ok: true });
  }
  return null; // no es una ruta de prospección
}

export async function otraProspecto(env, datos, chat) {
  await env.DB.prepare("UPDATE prospectos SET estado = 'nuevo' WHERE id = ?").bind(datos.prospecto_id).run();
  const pr = await env.DB.prepare("SELECT cliente_id FROM prospectos WHERE id = ?").bind(datos.prospecto_id).first();
  await despacharWorkflow(env, "prospectar.yml", { cliente: pr.cliente_id, accion: "escribir", prospeccion: datos.prospeccion_id });
  if (chat) await responder(env, chat, "🔄 En 1 o 2 minutos llega otra versión.");
}
