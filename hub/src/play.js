// Reseñas de Google Play: se leen con la cuenta de servicio de cada cliente, Gemini propone la respuesta
// y se publica cuando se aprueba. La API de Google solo devuelve las reseñas de la última semana.

import { gemini, registrar, notificar, destinatarios, tg, cifrar, descifrar, hex, bytesABase64 } from "./comun.js";

const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

// ---------------------------------------------------------------- acceso con la cuenta de servicio

// Token de Google a partir de la cuenta de servicio (JWT firmado con su clave privada). Se guarda 50 minutos.
export async function tokenGoogle(env, c) {
  const guardado = await env.ARCHIVOS.get("gtoken:" + c.id);
  if (guardado) return guardado;
  const cuenta = JSON.parse(await descifrar(env, c.play_cuenta));
  const ahora = Math.floor(Date.now() / 1000);
  const b64url = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const sinFirma = b64url({ alg: "RS256", typ: "JWT" }) + "." + b64url({
    iss: cuenta.client_email, scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600,
  });
  const der = Uint8Array.from(atob(cuenta.private_key.replace(/-----[^-]+-----|\s/g, "")), (x) => x.charCodeAt(0));
  const clave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, new TextEncoder().encode(sinFirma)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: sinFirma + "." + base64url(firma) }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google no aceptó la cuenta de servicio: " + (j.error_description || j.error || JSON.stringify(j)));
  await env.ARCHIVOS.put("gtoken:" + c.id, j.access_token, { expirationTtl: 3000 });
  return j.access_token;
}

function base64url(bytes) {
  return bytesABase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function playGet(token, ruta) {
  const r = await fetch(`${PLAY_API}/${ruta}`, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || JSON.stringify(j));
  return j;
}

// Valida y guarda la cuenta de servicio (el JSON que se descarga de Google Cloud).
export async function guardarCuentaPlay(env, clienteId, json) {
  let cuenta;
  try {
    cuenta = JSON.parse(json);
  } catch {
    throw new Error("eso no es el archivo JSON de la cuenta de servicio");
  }
  if (cuenta.type !== "service_account" || !cuenta.private_key || !cuenta.client_email) {
    throw new Error("falta private_key o client_email: subí el JSON completo de la cuenta de servicio");
  }
  await env.DB.prepare("UPDATE clientes SET play_cuenta = ?, play_sincronizado = NULL WHERE id = ?").bind(await cifrar(env, json), clienteId).run();
  await env.ARCHIVOS.delete("gtoken:" + clienteId);
  return cuenta.client_email;
}

// Prueba la conexión con cada app del cliente (para el botón del panel).
export async function probarPlay(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c.play_cuenta) return { error: "todavía no cargaste la cuenta de servicio" };
  const token = await tokenGoogle(env, c);
  const apps = [];
  for (const app of JSON.parse(c.play_apps || "[]")) {
    try {
      const j = await playGet(token, `${app}/reviews?maxResults=50`);
      apps.push({ app, ok: true, resenas: (j.reviews || []).length });
    } catch (e) {
      apps.push({ app, ok: false, error: e.message });
    }
  }
  return { ok: true, apps };
}

// ---------------------------------------------------------------- sincronizar y proponer

// Un cliente por pasada, cada 30 minutos.
export async function sincronizarPlaySiguiente(env) {
  const c = await env.DB.prepare(
    "SELECT * FROM clientes WHERE activo = 1 AND play_cuenta IS NOT NULL AND play_apps != '[]' " +
    "AND (play_sincronizado IS NULL OR play_sincronizado < datetime('now', '-30 minutes')) ORDER BY play_sincronizado IS NOT NULL, play_sincronizado LIMIT 1"
  ).first();
  if (!c) return;
  await env.DB.prepare("UPDATE clientes SET play_sincronizado = datetime('now') WHERE id = ?").bind(c.id).run();
  try {
    const token = await tokenGoogle(env, c);
    for (const app of JSON.parse(c.play_apps)) {
      const { reviews = [] } = await playGet(token, `${app}/reviews?maxResults=50`);
      for (const r of reviews) {
        const usuario = r.comments?.find((x) => x.userComment)?.userComment;
        const nuestra = r.comments?.find((x) => x.developerComment)?.developerComment;
        if (!usuario) continue;
        await env.DB.prepare(
          "INSERT INTO resenas (id, cliente_id, app, autor, estrellas, texto, version, fecha, respuesta, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET texto = excluded.texto, estrellas = excluded.estrellas, respuesta = excluded.respuesta, " +
          "estado = CASE WHEN excluded.respuesta IS NOT NULL THEN 'respondido' WHEN resenas.texto != excluded.texto AND resenas.estado != 'propuesto' THEN 'nuevo' ELSE resenas.estado END"
        ).bind(
          r.reviewId, c.id, app, r.authorName || "", usuario.starRating || null, (usuario.text || "").trim(), usuario.appVersionName || null,
          new Date(Number(usuario.lastModified?.seconds || 0) * 1000).toISOString().slice(0, 19), nuestra?.text || null,
          nuestra ? "respondido" : "nuevo",
        ).run();
      }
    }
  } catch (e) {
    await registrar(env, c.id, "error", "reseñas de Google Play: " + e.message);
  }
}

// Hasta 2 reseñas nuevas por pasada.
export async function proponerResenas(env) {
  const { results } = await env.DB.prepare(
    "SELECT r.*, c.nombre, c.marca FROM resenas r JOIN clientes c ON c.id = r.cliente_id WHERE r.estado = 'nuevo' ORDER BY r.fecha LIMIT 2"
  ).all();
  for (const re of results) {
    let r;
    try {
      r = await gemini(env, `${re.marca}

---
Respondés las reseñas de Google Play de la app de ${re.nombre} (paquete ${re.app}).
Reseña de ${re.autor || "un usuario"} — ${re.estrellas} de 5 estrellas${re.version ? `, versión ${re.version}` : ""}:
"${re.texto || "(sin texto, solo estrellas)"}"

Respondé SOLO con un JSON:
- "categoria": "elogio" | "problema" | "pedido" | "queja" | "spam" | "otro"
- "accion": "responder" | "ignorar"
- "respuesta": máximo 330 caracteres; agradecé, si hay un problema reconocelo y decí qué hacer (actualizar,
  escribir al soporte que figure en la marca) sin prometer fechas ni funciones que no estén confirmadas; cálido y humano,
  en el idioma de la reseña, sin hashtags ni emojis de más.
- "urgente": true si es de 1 o 2 estrellas o reporta un error grave`);
    } catch (e) {
      console.log("Gemini reseñas:", e.message);
      return;
    }
    if (r.accion === "ignorar") {
      await env.DB.prepare("UPDATE resenas SET estado = 'ignorado', categoria = ? WHERE id = ?").bind(r.categoria, re.id).run();
      continue;
    }
    const id = `${re.cliente_id}-p${Date.now().toString(36)}${hex(crypto.getRandomValues(new Uint8Array(3)))}`;
    const datos = {
      resena_id: re.id, app: re.app, autor: re.autor, estrellas: re.estrellas, comentario: re.texto,
      respuesta: (r.respuesta || "").slice(0, 350), categoria: r.categoria, urgente: !!r.urgente || (re.estrellas || 5) <= 2,
    };
    await env.DB.prepare("INSERT INTO propuestas (id, cliente_id, tipo, titulo, datos) VALUES (?, ?, 'resena', ?, ?)")
      .bind(id, re.cliente_id, `Reseña de ${re.autor || "usuario"} (${re.estrellas}★)`, JSON.stringify(datos)).run();
    await env.DB.prepare("UPDATE resenas SET estado = 'propuesto', categoria = ? WHERE id = ?").bind(r.categoria, re.id).run();
    await registrar(env, re.cliente_id, "resena", `${re.estrellas}★ ${re.autor}: ${re.texto}`);
    await vistaPreviaResena(env, id);
  }
}

export async function vistaPreviaResena(env, id) {
  const p = await env.DB.prepare(
    "SELECT p.*, c.nombre AS cliente_nombre FROM propuestas p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
  ).bind(id).first();
  const d = JSON.parse(p.datos);
  const texto = `${d.urgente ? "🔴 URGENTE — " : ""}${"⭐".repeat(d.estrellas || 0)} ${p.cliente_nombre} · Google Play (${d.app})\n` +
    `${d.autor || "Usuario"}: «${d.comentario || "(solo estrellas)"}»\n\nRespuesta sugerida:\n${d.respuesta}\n\n— Respondé a este mensaje con otro texto para cambiarla (máx. 350 caracteres).`;
  const botones = { inline_keyboard: [[
    { text: "✅ Responder", callback_data: "ok:" + id },
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

export async function ejecutarResena(env, id) {
  const tomada = await env.DB.prepare(
    "UPDATE propuestas SET estado = 'publicando', actualizado = datetime('now') WHERE id = ? AND estado = 'aprobada'"
  ).bind(id).run();
  if (!tomada.meta.changes) return { ok: true, nota: "ya se está respondiendo" };
  const p = await env.DB.prepare("SELECT * FROM propuestas WHERE id = ?").bind(id).first();
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(p.cliente_id).first();
  const d = JSON.parse(p.datos);
  try {
    const respuesta = d.respuesta.slice(0, 350);
    const r = await fetch(`${PLAY_API}/${d.app}/reviews/${d.resena_id}:reply`, {
      method: "POST",
      headers: { Authorization: "Bearer " + (await tokenGoogle(env, c)), "Content-Type": "application/json" },
      body: JSON.stringify({ replyText: respuesta }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || JSON.stringify(j));
    await env.DB.prepare("UPDATE resenas SET estado = 'respondido', respuesta = ? WHERE id = ?").bind(respuesta, d.resena_id).run();
    await env.DB.prepare("UPDATE propuestas SET estado = 'publicada', resultado = '{}', actualizado = datetime('now') WHERE id = ?").bind(id).run();
    await registrar(env, c.id, "respondido", `reseña de ${d.autor}: ${respuesta}`);
    await notificar(env, c.id, `⭐ Reseña de ${d.autor} respondida en Google Play (${c.nombre}).`);
    return { ok: true };
  } catch (e) {
    await env.DB.prepare("UPDATE propuestas SET estado = 'error', resultado = ?, actualizado = datetime('now') WHERE id = ?")
      .bind(JSON.stringify({ error: String(e.message || e) }), id).run();
    await notificar(env, c.id, `⚠️ No pude responder la reseña de ${d.autor} (${c.nombre}): ${e.message}`);
    return { error: String(e.message || e) };
  }
}
