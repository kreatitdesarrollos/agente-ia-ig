// Agenda: el Vendedor ofrece horarios libres reales del Google Calendar del cliente y, cuando la persona elige uno,
// se crea el evento al enviar la respuesta. Usa una cuenta de servicio de Google con acceso al calendario
// (se comparte el calendario con el email de la cuenta de servicio, permiso "hacer cambios en eventos").

import { cifrar, descifrar, bytesABase64, registrar, notificar, horaLocal } from "./comun.js";

const CAL_API = "https://www.googleapis.com/calendar/v3";

async function tokenCalendario(env, c) {
  const guardado = await env.ARCHIVOS.get("gcal:" + c.id);
  if (guardado) return guardado;
  const cuenta = JSON.parse(await descifrar(env, c.agenda_cuenta));
  const ahora = Math.floor(Date.now() / 1000);
  const b64url = (bytes) => bytesABase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const json = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const sinFirma = json({ alg: "RS256", typ: "JWT" }) + "." + json({
    iss: cuenta.client_email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600,
  });
  const der = Uint8Array.from(atob(cuenta.private_key.replace(/-----[^-]+-----|\s/g, "")), (x) => x.charCodeAt(0));
  const clave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, new TextEncoder().encode(sinFirma)));
  const r = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: sinFirma + "." + b64url(firma) }),
  })).json();
  if (!r.access_token) throw new Error("Google no aceptó la cuenta de servicio: " + (r.error_description || r.error));
  await env.ARCHIVOS.put("gcal:" + c.id, r.access_token, { expirationTtl: 3000 });
  return r.access_token;
}

// Diferencia (en minutos) entre la hora local del cliente y UTC, para armar los horarios en su zona.
function desfase(zona, fecha) {
  const local = new Date(fecha.toLocaleString("en-US", { timeZone: zona }));
  const utc = new Date(fecha.toLocaleString("en-US", { timeZone: "UTC" }));
  return (local - utc) / 60000;
}

// Los próximos horarios libres (hasta 8), dentro del horario de atención y con 2 h de anticipación.
export async function horariosLibres(env, c) {
  const cfg = JSON.parse(c.agenda_config || "{}");
  const token = await tokenCalendario(env, c);
  const desde = new Date(Date.now() + 2 * 3600000), hasta = new Date(Date.now() + 8 * 86400000);
  const r = await (await fetch(`${CAL_API}/freeBusy`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: desde.toISOString(), timeMax: hasta.toISOString(), items: [{ id: cfg.calendario_id }] }),
  })).json();
  const ocupado = (r.calendars?.[cfg.calendario_id]?.busy || []).map((b) => [new Date(b.start), new Date(b.end)]);
  const libres = [], dur = (cfg.duracion || 30) * 60000;
  const [hd, md] = (cfg.desde || "09:00").split(":").map(Number), [hh, mh] = (cfg.hasta || "18:00").split(":").map(Number);
  for (let d = 0; d < 8 && libres.length < 8; d++) {
    const dia = new Date(Date.now() + d * 86400000);
    const off = desfase(c.zona, dia);
    const fechaLocal = new Date(dia.getTime() + off * 60000).toISOString().slice(0, 10);
    const semana = new Date(fechaLocal + "T12:00:00Z").getUTCDay() || 7; // 1 = lunes ... 7 = domingo
    if (!(cfg.dias || [1, 2, 3, 4, 5]).includes(semana)) continue;
    for (let m = hd * 60 + md; m + (cfg.duracion || 30) <= hh * 60 + mh && libres.length < 8; m += cfg.duracion || 30) {
      const inicio = new Date(Date.parse(`${fechaLocal}T00:00:00Z`) + (m - off) * 60000);
      if (inicio < desde) continue;
      const fin = new Date(inicio.getTime() + dur);
      if (ocupado.some(([a, b]) => inicio < b && fin > a)) continue;
      libres.push(`${fechaLocal}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
      m += (cfg.duracion || 30) * 2; // no ofrecer turnos pegados: más variedad de horarios
    }
  }
  return libres;
}

// Lo que el Vendedor necesita saber para ofrecer turnos (se agrega al prompt de la conversación).
export async function extrasAgenda(env, c) {
  const cfg = JSON.parse(c.agenda_config || "{}");
  if (!cfg.activo || !c.agenda_cuenta || !cfg.calendario_id) return { texto: "", claves: "" };
  try {
    const libres = await horariosLibres(env, c);
    const dias = ["", "lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
    const lista = libres.map((l) => `${l} (${dias[new Date(l.slice(0, 10) + "T12:00:00Z").getUTCDay() || 7]})`).join(", ");
    return {
      texto: `\nAgenda: podés ofrecer una reunión/demo/turno de ${cfg.duracion || 30} minutos en estos horarios libres (hora local): ${lista || "no hay horarios libres esta semana"}.\n`,
      claves: `\n- "agenda": SOLO si la persona ya eligió/aceptó uno de esos horarios exactos: {"inicio": "AAAA-MM-DDTHH:MM", "motivo": "qué se agenda"}; si no, null`,
    };
  } catch (e) {
    console.log("agenda:", e.message);
    return { texto: "", claves: "" };
  }
}

// Al enviar la respuesta: si confirmó un horario, se crea el evento (una sola vez).
export async function agendarSiCorresponde(env, c, ct, d) {
  if (!d.agenda?.inicio || d.agenda.creado) return;
  const cfg = JSON.parse(c.agenda_config || "{}");
  const off = desfase(c.zona, new Date());
  const inicio = new Date(Date.parse(d.agenda.inicio + ":00Z") - off * 60000);
  const fin = new Date(inicio.getTime() + (cfg.duracion || 30) * 60000);
  const quien = ct.nombre || (ct.usuario ? "@" + ct.usuario : "") || ct.telefono || "contacto";
  const r = await (await fetch(`${CAL_API}/calendars/${encodeURIComponent(cfg.calendario_id)}/events`, {
    method: "POST", headers: { Authorization: "Bearer " + (await tokenCalendario(env, c)), "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `${d.agenda.motivo || "Reunión"} — ${quien}`,
      description: `Agendado por el Vendedor del panel.\nCanal: ${ct.canal}\nContacto: ${[ct.nombre, ct.usuario && "@" + ct.usuario, ct.telefono, ct.email].filter(Boolean).join(" · ")}\nQué busca: ${ct.resumen || "-"}`,
      start: { dateTime: inicio.toISOString(), timeZone: c.zona }, end: { dateTime: fin.toISOString(), timeZone: c.zona },
    }),
  })).json();
  if (r.error) throw new Error("no pude agendar en Google Calendar: " + r.error.message);
  d.agenda.creado = true;
  d.agenda.enlace = r.htmlLink;
  await registrar(env, c.id, "agenda", `${d.agenda.inicio} — ${quien}: ${d.agenda.motivo || ""}`);
  await notificar(env, c.id, `📅 Agendado en ${c.nombre}: ${d.agenda.inicio.replace("T", " ")} con ${quien} (${d.agenda.motivo || "reunión"}).\n${r.htmlLink}`);
}

export async function guardarAgenda(env, clienteId, b) {
  if (b.config) {
    const cfg = { activo: !!b.config.activo, calendario_id: String(b.config.calendario_id || "").trim(), duracion: Math.max(15, Number(b.config.duracion) || 30),
      dias: (b.config.dias || [1, 2, 3, 4, 5]).map(Number), desde: b.config.desde || "09:00", hasta: b.config.hasta || "18:00" };
    await env.DB.prepare("UPDATE clientes SET agenda_config = ? WHERE id = ?").bind(JSON.stringify(cfg), clienteId).run();
  }
  if (b.cuenta) {
    const cuenta = JSON.parse(b.cuenta);
    if (cuenta.type !== "service_account") throw new Error("eso no es el JSON de una cuenta de servicio de Google");
    await env.DB.prepare("UPDATE clientes SET agenda_cuenta = ? WHERE id = ?").bind(await cifrar(env, b.cuenta), clienteId).run();
    await env.ARCHIVOS.delete("gcal:" + clienteId);
    return { ok: true, email: cuenta.client_email };
  }
  return { ok: true };
}

export async function probarAgenda(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c.agenda_cuenta) return { error: "falta la cuenta de servicio" };
  const libres = await horariosLibres(env, c);
  return { ok: true, libres, hora: horaLocal(c.zona).hora };
}
