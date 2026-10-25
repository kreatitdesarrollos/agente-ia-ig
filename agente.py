"""
Agente de Instagram para Kreatit.

Comandos:
  python agente.py generar        -> crea el post del día y lo manda a Telegram para aprobar
  python agente.py revisar        -> lee botones/respuestas de Telegram y publica lo aprobado
                                     (/nuevo en Telegram crea un post extra; /nuevo <tema> sobre ese tema)
  python agente.py verificar      -> chequea claves y muestra tu IG_USER_ID
  python agente.py renovar-token  -> renueva el token de Instagram (imprime el nuevo)
"""
import base64
import datetime as dt
import io
import json
import os
import random
import re
import sys
import time
import unicodedata
import urllib.parse
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from PIL import Image, ImageDraw

RAIZ = Path(__file__).parent
ESTADO = RAIZ / "estado.json"
HISTORIAL = RAIZ / "historial.json"
CALENDARIO = RAIZ / "calendario.json"
MARCA = RAIZ / "marca.md"
LOGO = RAIZ / "logo.png"
FOTOS = RAIZ / "fotos"
POSTS = RAIZ / "posts"

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
# si el principal está saturado o no existe, se prueban estos en orden
GEMINI_RESPALDO = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"]
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
TG_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
IG_TOKEN = os.environ.get("IG_TOKEN", "")
IG_USER_ID = os.environ.get("IG_USER_ID", "")
IG_API = "https://graph.instagram.com/" + os.environ.get("IG_API_VERSION", "v23.0")
AUTO_PUBLICAR = os.environ.get("AUTO_PUBLICAR", "false").lower() == "true"
ZONA = ZoneInfo(os.environ.get("ZONA_HORARIA", "America/Argentina/Buenos_Aires"))
# URL pública donde Instagram descarga la imagen (en GitHub Actions se arma sola)
URL_BASE = os.environ.get("URL_BASE_IMAGENES") or "https://raw.githubusercontent.com/{}/{}/posts/".format(
    os.environ.get("GITHUB_REPOSITORY", "usuario/repo"), os.environ.get("GITHUB_REF_NAME", "main")
)

DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
EXT_FOTOS = {".jpg", ".jpeg", ".png", ".webp"}


# ---------- utilidades ----------

def leer_json(ruta, defecto):
    return json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else defecto


def guardar_json(ruta, datos):
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")


def ahora():
    return dt.datetime.now(ZONA)


def ajustar_imagen(img):
    """Recorta a 4:5 (1080x1350, el formato que más ocupa en el feed) y pega el logo si existe."""
    img = img.convert("RGB")
    ancho, alto = img.size
    objetivo = 4 / 5
    if ancho / alto > objetivo:
        nuevo = int(alto * objetivo)
        img = img.crop(((ancho - nuevo) // 2, 0, (ancho + nuevo) // 2, alto))
    else:
        nuevo = int(ancho / objetivo)
        img = img.crop((0, (alto - nuevo) // 2, ancho, (alto + nuevo) // 2))
    img = img.resize((1080, 1350), Image.LANCZOS)
    return poner_logo(img)


def enmarcar(img):
    """Para capturas de las apps/juegos: la imagen entera, sin recortar, sobre un fondo con los colores
    de la marca (1080x1350). Así las capturas horizontales no pierden los costados."""
    fondo = Image.new("RGB", (1080, 1350))
    trazo = ImageDraw.Draw(fondo)
    arriba, abajo = (20, 24, 61), (76, 62, 140)  # azul profundo -> violeta
    for y in range(1350):
        t = y / 1349
        trazo.line([(0, y), (1080, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(arriba, abajo)))
    img = img.convert("RGB")
    escala = min((1080 - 2 * 60) / img.width, (1350 - 2 * 110) / img.height)
    img = img.resize((int(img.width * escala), int(img.height * escala)), Image.LANCZOS)
    mascara = Image.new("L", img.size, 0)
    ImageDraw.Draw(mascara).rounded_rectangle([(0, 0), img.size], radius=28, fill=255)
    fondo.paste(img, ((1080 - img.width) // 2, (1350 - img.height) // 2), mascara)
    return poner_logo(fondo)


def poner_logo(img):
    if LOGO.exists():
        logo = Image.open(LOGO).convert("RGBA")
        lw = 160
        logo = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
        img.paste(logo, (1080 - lw - 40, 1350 - logo.height - 40), logo)
    return img


# ---------- IA: texto (Gemini, capa gratuita) ----------

def gemini(prompt, imagen_jpg=None):
    partes = [{"text": prompt}]
    if imagen_jpg:
        partes.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(imagen_jpg).decode()}})
    cuerpo = {"contents": [{"parts": partes}], "generationConfig": {"responseMimeType": "application/json"}}
    modelos = [GEMINI_MODEL] + [m for m in GEMINI_RESPALDO if m != GEMINI_MODEL]
    ultimo_error = None
    for intento in range(4):  # varias vueltas por todos los modelos, esperando cada vez más
        for modelo in modelos:
            try:
                r = requests.post(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent".format(modelo),
                    headers={"x-goog-api-key": GEMINI_KEY}, json=cuerpo, timeout=180,
                )
            except requests.exceptions.RequestException as e:
                print("Gemini ({}) no respondió: {}".format(modelo, e))
                ultimo_error = e
                continue
            if r.ok:
                partes_resp = r.json()["candidates"][0]["content"]["parts"]
                return json.loads("".join(p["text"] for p in partes_resp if "text" in p and not p.get("thought")))
            print("Gemini ({}) respondió {}: {}".format(modelo, r.status_code, r.text[:500]))
            ultimo_error = requests.HTTPError("{} en {}".format(r.status_code, modelo), response=r)
            if r.status_code in (400, 401, 403):  # clave mala: no tiene sentido reintentar
                raise ultimo_error
        time.sleep(30 * (intento + 1))
    raise ultimo_error


def pedir_texto(tipo_post, temas_previos, foto=None):
    prompt = """{marca}

---
Hoy es {dia} {fecha}. Tipo de post de hoy: {tipo}

Temas ya publicados recientemente (NO los repitas): {previos}

{extra}

Respondé SOLO con un JSON con estas claves:
- "tema": título corto interno del post (máx 8 palabras)
- "caption": texto del post listo para Instagram, con saltos de línea, emojis con moderación,
  un gancho fuerte en la primera línea y un llamado a la acción al final. Máx 1500 caracteres.
  Texto plano: Instagram no muestra negritas, así que no uses ** ni otro formato markdown.
- "hashtags": string con 8 a 12 hashtags relevantes separados por espacio
- "prompt_imagen": {prompt_img}
""".format(
        marca=MARCA.read_text(encoding="utf-8"),
        dia=DIAS[ahora().weekday()],
        fecha=ahora().strftime("%d/%m/%Y"),
        tipo=tipo_post,
        previos=", ".join(temas_previos[-30:]) or "ninguno",
        extra="Te adjunto la foto real que vamos a publicar: escribí el texto basándote en lo que se ve." if foto else "",
        prompt_img='""' if foto else (
            "descripción EN INGLÉS de la imagen a generar: estilo moderno, tecnológico, colores de la marca, "
            "sin texto ni letras dentro de la imagen, composición vertical."
        ),
    )
    return gemini(prompt, foto)


# ---------- IA: imagen (Cloudflare Workers AI gratis; Pollinations de respaldo) ----------

def generar_imagen(prompt):
    if CF_ACCOUNT_ID and CF_API_TOKEN:
        try:
            return imagen_cloudflare(prompt)
        except Exception as e:
            print("Cloudflare falló, uso Pollinations:", e, file=sys.stderr)
    return imagen_pollinations(prompt)


def imagen_cloudflare(prompt):
    r = requests.post(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/@cf/black-forest-labs/flux-1-schnell".format(CF_ACCOUNT_ID),
        headers={"Authorization": "Bearer " + CF_API_TOKEN},
        json={"prompt": prompt, "steps": 8},
        timeout=120,
    )
    r.raise_for_status()
    return Image.open(io.BytesIO(base64.b64decode(r.json()["result"]["image"])))


def imagen_pollinations(prompt):
    url ="https://image.pollinations.ai/prompt/{}?width=1080&height=1350&nologo=true&model=flux&seed={}".format(
        urllib.parse.quote(prompt), random.randint(1, 10**9)
    )
    for intento in range(3):
        try:
            r = requests.get(url, timeout=180)
            if r.ok and r.headers.get("content-type", "").startswith("image"):
                return Image.open(io.BytesIO(r.content))
        except requests.RequestException:
            pass
        time.sleep(10 * (intento + 1))
    raise RuntimeError("No se pudo generar la imagen con Pollinations")


def normalizar(texto):
    return unicodedata.normalize("NFKD", texto.lower()).encode("ascii", "ignore").decode()


def producto_de(pedido):
    """La carpeta de fotos/ cuyo nombre está en el pedido (todas sus palabras). Si hay varias, la más específica:
    "la app Vagón" -> fotos/Vagón app; "el juego Vagón" -> fotos/vagón."""
    palabras = set(re.findall(r"\w+", normalizar(pedido)))
    candidatas = [d for d in FOTOS.iterdir() if d.is_dir() and set(re.findall(r"\w+", normalizar(d.name))) <= palabras]
    return max(candidatas, key=lambda d: len(d.name.split()), default=None)


def producto_que_toca(nombres, historial):
    """De los productos del calendario, el que hace más tiempo que no sale."""
    ultimo = {normalizar(h["foto"].split("/")[0]): i for i, h in enumerate(historial) if "/" in (h.get("foto") or "")}
    return min(nombres, key=lambda n: ultimo.get(normalizar(n), -1))


def foto_de_producto(carpeta, historial):
    """La foto de la carpeta que hace más tiempo que no se usa (las nunca usadas primero)."""
    fotos = [f for f in sorted(carpeta.iterdir()) if f.suffix.lower() in EXT_FOTOS]
    ultimo = {h.get("foto"): i for i, h in enumerate(historial)}
    return min(fotos, key=lambda f: ultimo.get(str(f.relative_to(FOTOS)), -1), default=None)


def elegir_foto_propia(historial):
    usadas = {h.get("foto") for h in historial}
    disponibles = [f for f in sorted(FOTOS.glob("*")) if f.suffix.lower() in EXT_FOTOS and f.name not in usadas]
    return disponibles[0] if disponibles else None


# ---------- Telegram (aprobación) ----------

def tg(metodo, **kwargs):
    r = requests.post("https://api.telegram.org/bot{}/{}".format(TG_TOKEN, metodo), timeout=60, **kwargs)
    if not r.ok:
        print("Telegram ({}) respondió: {}".format(metodo, r.text[:500]))
    r.raise_for_status()
    return r.json()["result"]


def avisar(texto):
    tg("sendMessage", data={"chat_id": TG_CHAT, "text": texto})


def enviar_vista_previa(post):
    with open(POSTS / post["imagen"], "rb") as f:
        tg("sendPhoto", data={"chat_id": TG_CHAT, "caption": "📝 Post propuesto: " + post["tema"]}, files={"photo": f})
    botones = {"inline_keyboard": [[
        {"text": "✅ Publicar", "callback_data": "ok:" + post["id"]},
        {"text": "🔄 Otra", "callback_data": "otra:" + post["id"]},
        {"text": "❌ Descartar", "callback_data": "no:" + post["id"]},
    ]]}
    texto = texto_final(post) + "\n\n— Respondé con texto para reemplazar el caption, o /nuevo para otro post."
    tg("sendMessage", data={"chat_id": TG_CHAT, "text": texto[:4096], "reply_markup": json.dumps(botones)})


def texto_final(post):
    return "{}\n\n{}".format(post["caption"].strip(), post["hashtags"].strip()).strip()


# ---------- Instagram ----------

def publicar_en_instagram(post):
    url_imagen = URL_BASE + post["imagen"]
    if requests.head(url_imagen, timeout=30).status_code != 200:
        raise RuntimeError("La imagen todavía no es pública: " + url_imagen)
    r = requests.post("{}/{}/media".format(IG_API, IG_USER_ID), data={
        "image_url": url_imagen, "caption": texto_final(post)[:2200], "access_token": IG_TOKEN,
    }, timeout=60)
    r.raise_for_status()
    contenedor = r.json()["id"]
    for _ in range(20):  # Instagram procesa la imagen antes de dejar publicarla
        estado = requests.get("{}/{}".format(IG_API, contenedor),
                              params={"fields": "status_code", "access_token": IG_TOKEN}, timeout=30).json()
        if estado.get("status_code") == "FINISHED":
            break
        if estado.get("status_code") == "ERROR":
            raise RuntimeError("Instagram rechazó la imagen: {}".format(estado))
        time.sleep(5)
    r = requests.post("{}/{}/media_publish".format(IG_API, IG_USER_ID),
                      data={"creation_id": contenedor, "access_token": IG_TOKEN}, timeout=60)
    r.raise_for_status()
    media_id = r.json()["id"]
    enlace = requests.get("{}/{}".format(IG_API, media_id),
                          params={"fields": "permalink", "access_token": IG_TOKEN}, timeout=30).json()
    return media_id, enlace.get("permalink", "")


# ---------- flujo principal ----------

def crear_post(estado, historial, pedido=None):
    calendario = leer_json(CALENDARIO, {})
    dia = calendario.get(DIAS[ahora().weekday()], {"tipo": "post libre sobre los servicios de la empresa"})
    carpeta = None
    if pedido:  # tema pedido por Telegram con "/nuevo <tema>": manda sobre el calendario
        dia = {"tipo": 'post a pedido del dueño: "{}". Si menciona un producto propio, usá la info de '
                       '"Nuestros productos" y no inventes datos que no estén ahí.'.format(pedido)}
        carpeta = producto_de(pedido)
    elif dia.get("productos"):  # días de promo: rota entre los productos de la lista
        carpeta = producto_de(producto_que_toca(dia["productos"], historial))
        dia = {"tipo": '{} Hoy el post es sobre: "{}" (usá su info de "Nuestros productos" y no inventes '
                       'datos que no estén ahí).'.format(dia["tipo"], carpeta.name)}
    if carpeta:
        foto = foto_de_producto(carpeta, historial)
    else:
        foto = elegir_foto_propia(historial) if dia.get("foto_propia") else None
    temas = [h["tema"] for h in historial]
    id_post = ahora().strftime("%Y%m%d-%H%M%S")

    if foto:
        img = enmarcar(Image.open(foto)) if carpeta else ajustar_imagen(Image.open(foto))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        datos = pedir_texto(dia["tipo"], temas, buf.getvalue())
    else:
        datos = pedir_texto(dia["tipo"], temas)
        img = ajustar_imagen(generar_imagen(datos["prompt_imagen"]))

    POSTS.mkdir(exist_ok=True)
    nombre = id_post + ".jpg"
    img.save(POSTS / nombre, "JPEG", quality=90)
    post = {
        "id": id_post, "tema": datos["tema"], "caption": datos["caption"], "hashtags": datos["hashtags"],
        "imagen": nombre, "foto": str(foto.relative_to(FOTOS)) if foto else None, "aprobado": AUTO_PUBLICAR, "pedido": pedido,
    }
    estado["pendiente"] = post
    if AUTO_PUBLICAR:
        avisar("🤖 Modo automático: se publicará en unos minutos → " + post["tema"])
    else:
        enviar_vista_previa(post)


def cmd_generar():
    estado = leer_json(ESTADO, {})
    historial = leer_json(HISTORIAL, [])
    if estado.get("pendiente") and not estado["pendiente"].get("aprobado"):
        avisar("⏳ Quedó un post sin aprobar de antes, lo reemplazo por el de hoy.")
    crear_post(estado, historial)
    guardar_json(ESTADO, estado)


def cmd_revisar():
    estado = leer_json(ESTADO, {})
    historial = leer_json(HISTORIAL, [])
    updates = tg("getUpdates", data={"offset": estado.get("offset", 0), "timeout": 0})

    for u in updates:
        estado["offset"] = u["update_id"] + 1
        pend = estado.get("pendiente")

        if "callback_query" in u:
            cb = u["callback_query"]
            try:  # solo apaga el "cargando" del botón; Telegram lo rechaza si el clic tiene más de unos minutos
                tg("answerCallbackQuery", data={"callback_query_id": cb["id"]})
            except requests.exceptions.RequestException:
                pass
            if str(cb["message"]["chat"]["id"]) != TG_CHAT:
                continue
            accion, _, id_post = cb["data"].partition(":")
            if not pend or pend["id"] != id_post:
                avisar("Ese post ya no está pendiente.")
            elif accion == "ok":
                pend["aprobado"] = True
                avisar("👍 Aprobado, publicando...")
            elif accion == "otra":
                avisar("🔄 Generando otra versión...")
                crear_post(estado, historial, pend.get("pedido"))
            elif accion == "no":
                estado["pendiente"] = None
                avisar("🗑️ Descartado. Mandá /nuevo si querés otro.")

        elif "message" in u and str(u["message"]["chat"]["id"]) == TG_CHAT:
            texto = u["message"].get("text", "").strip()
            if texto.split(" ")[0].split("@")[0] == "/nuevo":
                pedido = texto.partition(" ")[2].strip() or None
                avisar("✨ Generando un post nuevo" + (" sobre: " + pedido if pedido else "") + "...")
                crear_post(estado, historial, pedido)
            elif texto == "/start":
                avisar("Hola! Tu chat_id es {}".format(u["message"]["chat"]["id"]))
            elif texto and pend and not pend.get("aprobado"):
                pend["caption"], pend["hashtags"] = texto, ""
                enviar_vista_previa(pend)

    # Publicar lo aprobado. Solo publica imágenes de corridas anteriores, que ya están subidas al repo.
    pend = estado.get("pendiente")
    if pend and pend.get("aprobado"):
        try:
            media_id, enlace = publicar_en_instagram(pend)
            historial.append({"fecha": ahora().isoformat(), "tema": pend["tema"], "foto": pend["foto"],
                              "imagen": pend["imagen"], "media_id": media_id})
            estado["pendiente"] = None
            avisar("🚀 ¡Publicado! " + enlace)
        except Exception as e:  # se reintenta en la próxima revisión
            print("Error publicando:", e, file=sys.stderr)
            if "todavía no es pública" not in str(e):
                avisar("⚠️ Error al publicar (reintento en la próxima revisión): {}".format(e)[:4000])

    guardar_json(ESTADO, estado)
    guardar_json(HISTORIAL, historial)


def cmd_verificar():
    print("Gemini:", "OK" if gemini('Respondé {"ok": true}').get("ok") else "respuesta rara")
    print("Telegram bot:", tg("getMe")["username"])
    r = requests.get(IG_API + "/me", params={"fields": "user_id,username", "access_token": IG_TOKEN}, timeout=30)
    print("Instagram:", r.json(), "-> usá 'user_id' como IG_USER_ID")


def cmd_renovar_token():
    r = requests.get("https://graph.instagram.com/refresh_access_token",
                     params={"grant_type": "ig_refresh_token", "access_token": IG_TOKEN}, timeout=30)
    r.raise_for_status()
    print(r.json()["access_token"])


if __name__ == "__main__":
    comandos = {"generar": cmd_generar, "revisar": cmd_revisar,
                "verificar": cmd_verificar, "renovar-token": cmd_renovar_token}
    if len(sys.argv) < 2 or sys.argv[1] not in comandos:
        print(__doc__)
        sys.exit(1)
    comandos[sys.argv[1]]()
