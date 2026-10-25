// Portero del agente (Cloudflare Worker, gratis).
// Telegram le avisa al instante cada botón o mensaje (webhook). El portero:
//   1. apaga el "conectando" del botón con un "Recibido ✅",
//   2. guarda el mensaje en una cola (KV) para que no se pierda,
//   3. despierta al agente en GitHub Actions, pasándole el mensaje.
// El agente lee la cola en /pendientes y, cuando termina, borra lo procesado con /confirmar.
//
// Secretos (wrangler secret put): TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, GH_TOKEN.
// La clave compartida con el agente es el sha256 del token de Telegram, así no hace falta otro secreto.

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const clave = await sha256(env.TELEGRAM_TOKEN);

    if (url.pathname === "/telegram" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== clave) return new Response("no", { status: 403 });
      const u = await req.json();
      const chat = String((u.callback_query ? u.callback_query.message : u.message)?.chat?.id ?? "");
      if (chat !== env.TELEGRAM_CHAT_ID) return new Response("ok");

      await env.COLA.put(llave(u.update_id), JSON.stringify(u), { expirationTtl: 7 * 86400 });
      if (u.callback_query) {
        ctx.waitUntil(tg(env, "answerCallbackQuery", {
          callback_query_id: u.callback_query.id,
          text: "Recibido ✅ En un minuto te confirmo.",
        }));
      }
      ctx.waitUntil(despertarAgente(env, u));
      return new Response("ok");
    }

    if (req.headers.get("X-Clave") !== clave) return new Response("no", { status: 403 });

    if (url.pathname === "/pendientes") {
      const { keys } = await env.COLA.list({ prefix: "u:" });
      const updates = await Promise.all(keys.map((k) => env.COLA.get(k.name, "json")));
      return Response.json(updates.filter(Boolean));
    }

    if (url.pathname === "/confirmar" && req.method === "POST") {
      const { ids } = await req.json();
      await Promise.all(ids.map((id) => env.COLA.delete(llave(id))));
      return new Response("ok");
    }

    return new Response("no", { status: 404 });
  },
};

function llave(updateId) {
  return "u:" + String(updateId).padStart(12, "0");
}

async function sha256(texto) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tg(env, metodo, datos) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datos),
  });
}

async function despertarAgente(env, update) {
  // El mensaje va también en el aviso: así el agente lo tiene aunque la cola tarde unos segundos en verse.
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/agente.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "kreatit-portero",
    },
    body: JSON.stringify({ ref: "main", inputs: { comando: "revisar", update: JSON.stringify(update) } }),
  });
  if (!r.ok) console.log("GitHub no aceptó el aviso:", r.status, await r.text());
}
