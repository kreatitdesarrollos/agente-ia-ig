// Escudo de los sitios de Kreatit (Cloudflare Worker delante del hosting).
// Lo pidió el agente de seguridad: el sitio está publicado con la carpeta entera del proyecto Laravel como raíz,
// así que acá se bloquean los archivos privados y se agregan los encabezados de seguridad, sin tocar el hosting.
// Si algo falla en el escudo, la visita pasa directo al hosting (passThroughOnException): nunca deja el sitio caído.

const PRIVADOS = [
  /^\/\.(?!well-known\/)/i,                        // .env, .git, .htaccess... (menos .well-known: lo usa la renovación del SSL)
  /^\/storage\/(logs|framework)(\/|$)/i,           // logs y caché de Laravel
  /^\/bootstrap\/cache(\/|$)/i,
  /^\/(composer\.(json|lock)|package(-lock)?\.json|artisan|phpunit\.xml|vite\.config\.js|webpack\.mix\.js)$/i,
  /^\/vendor\/composer(\/|$)/i,                    // lista exacta de librerías y versiones
  /^\/vendor\/.*\.(json|lock|md|txt|xml|dist)$/i,
  /\.(log|sql|bak|old|orig|swp|env)$/i,
  /^\/phpinfo\.php$/i,
];

export default {
  async fetch(req, env, ctx) {
    ctx.passThroughOnException();
    let ruta;
    try {
      ruta = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (PRIVADOS.some((r) => r.test(ruta))) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }

    const r = await fetch(req);
    const h = new Headers(r.headers);
    h.delete("X-Powered-By");
    if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
    if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
    if (!h.has("Strict-Transport-Security")) h.set("Strict-Transport-Security", "max-age=31536000");
    if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  },
};
