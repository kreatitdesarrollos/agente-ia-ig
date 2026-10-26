// Herramientas compartidas por todos los módulos del hub.

export const IG_API = "https://graph.instagram.com/v23.0";

// Quiénes reciben los avisos de un cliente: la agencia y los usuarios de ese cliente, con Telegram vinculado.
export async function destinatarios(env, clienteId, soloPrevias = false) {
  const { results } = await env.DB.prepare(
    "SELECT tg_chat FROM usuarios WHERE activo = 1 AND tg_chat IS NOT NULL AND (rol = 'agencia' OR cliente_id = ?)" +
    (soloPrevias ? " AND recibe_previas = 1" : "")
  ).bind(clienteId).all();
  return results.map((u) => u.tg_chat);
}

export async function notificar(env, clienteId, texto) {
  for (const chat of await destinatarios(env, clienteId)) await tg(env, "sendMessage", { chat_id: chat, text: texto });
}

export async function avisarAgencia(env, texto) {
  const { results } = await env.DB.prepare("SELECT tg_chat FROM usuarios WHERE rol = 'agencia' AND activo = 1 AND tg_chat IS NOT NULL").all();
  for (const u of results) await tg(env, "sendMessage", { chat_id: u.tg_chat, text: texto });
}

export function responder(env, chat, texto) {
  return tg(env, "sendMessage", { chat_id: chat, text: texto });
}


export function textoFinal(datos) {
  return `${(datos.caption || "").trim()}\n\n${(datos.hashtags || "").trim()}`.trim();
}


export function horaLocal(zona) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}



export async function tg(env, metodo, datos) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos),
  });
  const j = await r.json();
  if (!j.ok) console.log(`Telegram ${metodo}:`, JSON.stringify(j));
  return j;
}

export function registrar(env, cliente, tipo, detalle) {
  return env.DB.prepare("INSERT INTO eventos (cliente_id, tipo, detalle) VALUES (?, ?, ?)").bind(cliente, tipo, String(detalle).slice(0, 1000)).run();
}

export async function igPost(url, datos) {
  const r = await fetch(url, { method: "POST", body: new URLSearchParams(datos) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || JSON.stringify(j));
  return j;
}

export async function igGet(url, params) {
  const r = await fetch(url + "?" + new URLSearchParams(params));
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || JSON.stringify(j));
  return j;
}

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// La clave que comparten Telegram (secret_token), el generador y el hub: sha256 del token del bot.
export async function claveAgente(env) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_TOKEN)));
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64ABytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function bytesABase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Los tokens de los clientes se guardan cifrados (AES-GCM) con CLAVE_CIFRADO.
async function claveCifrado(env) {
  return crypto.subtle.importKey("raw", base64ABytes(env.CLAVE_CIFRADO), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function cifrar(env, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await claveCifrado(env), new TextEncoder().encode(texto)));
  const todo = new Uint8Array(iv.length + datos.length);
  todo.set(iv);
  todo.set(datos, iv.length);
  return "v1:" + bytesABase64(todo);
}

export async function descifrar(env, guardado) {
  const todo = base64ABytes(guardado.slice(3));
  const datos = await crypto.subtle.decrypt({ name: "AES-GCM", iv: todo.slice(0, 12) }, await claveCifrado(env), todo.slice(12));
  return new TextDecoder().decode(datos);
}

// Dispara un workflow de GitHub Actions (generar.yml, investigar.yml...).
export async function despacharWorkflow(env, archivo, inputs) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${archivo}/dispatches`, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "kreatit-hub" },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (!r.ok) {
    const error = `GitHub no aceptó ${archivo} (${r.status}): ${(await r.text()).slice(0, 300)}`;
    await registrar(env, inputs.cliente || null, "error", error);
    await avisarAgencia(env, "⚠️ " + error);
  }
}

// Gemini (capa gratis) con modelos de respaldo: si uno está saturado o no existe, prueba el siguiente.
// Devuelve el JSON que pide el prompt, o tira error si ninguno respondió.
const MODELOS_GEMINI = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"];

export async function gemini(env, prompt) {
  let ultimo = "sin respuesta";
  for (const modelo of MODELOS_GEMINI) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) {
        ultimo = `${modelo} ${r.status}`;
        if ([400, 401, 403].includes(r.status)) break;
        continue;
      }
      const partes = (await r.json()).candidates[0].content.parts;
      return JSON.parse(partes.filter((p) => p.text && !p.thought).map((p) => p.text).join(""));
    } catch (e) {
      ultimo = `${modelo}: ${e.message}`;
    }
  }
  throw new Error("Gemini no respondió (" + ultimo + ")");
}
