"""
Editor de video (corre en GitHub Actions, workflow video.yml).

Arma un Reel vertical (1080x1920, 15-30 s) con las fotos, capturas o videos del cliente (o imágenes de IA si no hay):
Gemini escribe el guion (gancho, escenas, cierre), y ffmpeg edita: zoom suave, fondo desenfocado para capturas,
textos con la tipografía de la marca, transiciones, placa final y música del cliente si cargó alguna.
El video vuelve al hub como propuesta para aprobar y se publica como Reel.

  python video.py <cliente> [pedido] [producto]
"""
import base64
import io
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import agente
import requests

from generador import hub, HUB, CLAVE, producto_de, foto_menos_usada, texto_aprendizajes

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
W, H, FPS = 1080, 1920, 30
FUENTES = Path(__file__).parent / "fuentes"


def fuente(nombre, tam):
    return ImageFont.truetype(str(FUENTES / nombre), tam)


def ffmpeg(*args):
    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("ffmpeg: " + r.stderr[-800:])


def base36(n):
    letras = "0123456789abcdefghijklmnopqrstuvwxyz"
    texto = ""
    while n:
        n, r = divmod(n, 36)
        texto = letras[r] + texto
    return texto or "0"


def cubrir(img, w, h):
    img = img.convert("RGB")
    e = max(w / img.width, h / img.height)
    img = img.resize((int(img.width * e) + 1, int(img.height * e) + 1), Image.LANCZOS)
    x, y = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def partir(texto, f, ancho, trazo):
    lineas, actual = [], ""
    for p in texto.split():
        prueba = (actual + " " + p).strip()
        if actual and trazo.textlength(prueba, font=f) > ancho:
            lineas.append(actual)
            actual = p
        else:
            actual = prueba
    return lineas + ([actual] if actual else [])


def cartel(lienzo, texto, y, tam, color_fondo=(15, 17, 40, 210), color_texto=(255, 255, 255), negrita=True):
    """Texto centrado sobre una franja redondeada semitransparente (se lee sobre cualquier imagen)."""
    capa = Image.new("RGBA", lienzo.size, (0, 0, 0, 0))
    t = ImageDraw.Draw(capa)
    f = fuente("Poppins-Black.ttf" if negrita else "Poppins-SemiBold.ttf", tam)
    lineas = partir(texto, f, W - 160, t)
    alto = int(len(lineas) * tam * 1.18) + 50
    t.rounded_rectangle([(50, y), (W - 50, y + alto)], radius=36, fill=color_fondo)
    yy = y + 25
    for linea in lineas:
        t.text(((W - t.textlength(linea, font=f)) / 2, yy), linea, font=f, fill=color_texto)
        yy += int(tam * 1.18)
    lienzo.alpha_composite(capa)
    return y + alto


def cuadro_imagen(img):
    """Fondo: la misma imagen desenfocada y oscurecida; adelante, la imagen entera (las capturas no se recortan)."""
    fondo = cubrir(img, W, H).filter(ImageFilter.GaussianBlur(40))
    fondo = Image.blend(fondo, Image.new("RGB", (W, H), (10, 12, 35)), 0.45).convert("RGBA")
    frente = img.convert("RGB")
    e = min((W - 100) / frente.width, (H - 700) / frente.height)
    if frente.width / frente.height > 0.7:  # horizontal o cuadrada: con bordes redondeados en el medio
        frente = frente.resize((int(frente.width * e), int(frente.height * e)), Image.LANCZOS)
        mascara = Image.new("L", frente.size, 0)
        ImageDraw.Draw(mascara).rounded_rectangle([(0, 0), frente.size], radius=40, fill=255)
        fondo.paste(frente, ((W - frente.width) // 2, (H - frente.height) // 2 + 60), mascara)
        return fondo
    return cubrir(img, W, H).convert("RGBA")  # vertical: ocupa toda la pantalla


def escena_png(img, texto, gancho, ruta):
    lienzo = cuadro_imagen(img)
    if gancho:
        cartel(lienzo, gancho.upper(), 170, 92, color_fondo=(239, 108, 44, 235))
    if texto:
        cartel(lienzo, texto, H - 560, 62, negrita=False)
    lienzo.convert("RGB").save(ruta, quality=92)


def placa_final(texto, marca, ruta):
    lienzo = Image.new("RGB", (W, H))
    t = ImageDraw.Draw(lienzo)
    for y in range(H):
        k = y / H
        t.line([(0, y), (W, y)], fill=(int(20 + 56 * k), int(24 + 38 * k), int(61 + 79 * k)))
    lienzo = lienzo.convert("RGBA")
    y = cartel(lienzo, marca.upper(), 620, 110, color_fondo=(0, 0, 0, 0))
    cartel(lienzo, texto, y + 60, 70, color_fondo=(239, 108, 44, 240))
    lienzo.convert("RGB").save(ruta, quality=92)


def segmento_imagen(png, segundos, salida, zoom_entrada=True):
    frames = int(segundos * FPS)
    z = "min(zoom+0.0009,1.10)" if zoom_entrada else "if(eq(on,0),1.10,max(zoom-0.0009,1.0))"
    ffmpeg("-loop", "1", "-i", png, "-vf",
           "scale=1296:2304,zoompan=z='{}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={}:s={}x{}:fps={},"
           "fade=t=in:st=0:d=0.25,fade=t=out:st={}:d=0.25,format=yuv420p".format(z, frames, W, H, FPS, max(0, segundos - 0.25)),
           "-t", str(segundos), "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-color_range", "tv", "-an", salida)


def segmento_video(origen, desde, segundos, texto_png, salida):
    """Un tramo de un video del cliente, en vertical con fondo desenfocado, y el texto encima."""
    ffmpeg("-ss", str(desde), "-t", str(segundos), "-i", origen, "-i", texto_png, "-filter_complex",
           "[0:v]split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=30:5[fondo];"
           "[b]scale={w}:-2:force_original_aspect_ratio=decrease[frente];[fondo][frente]overlay=(W-w)/2:(H-h)/2[v];"
           "[v][1:v]overlay=0:0,fade=t=in:st=0:d=0.25,fade=t=out:st={f}:d=0.25,fps={fps},format=yuv420p".format(w=W, h=H, f=max(0, segundos - 0.25), fps=FPS),
           "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-color_range", "tv", "-an", salida)


def texto_transparente(texto, gancho, ruta):
    lienzo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if gancho:
        cartel(lienzo, gancho.upper(), 170, 92, color_fondo=(239, 108, 44, 235))
    if texto:
        cartel(lienzo, texto, H - 560, 62, negrita=False)
    lienzo.save(ruta)


def duracion(archivo):
    r = subprocess.run([FFMPEG, "-i", archivo], capture_output=True, text=True)
    for linea in r.stderr.splitlines():
        if "Duration:" in linea:
            h, m, s = linea.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0


def generar(cliente_id, pedido="", producto=""):
    trabajo = hub("/api/agente/trabajo", params={"cliente": cliente_id}).json()
    cliente, fotos, historial = trabajo["cliente"], trabajo["fotos"], trabajo["historial"]
    musica = [f for f in fotos if agente.normalizar(f["producto"]) == "musica" or (f.get("tipo") or "").startswith("audio/")]
    material = [f for f in fotos if f not in musica]
    productos = sorted({f["producto"] for f in material if f["producto"]})
    producto = producto or (producto_de(pedido, productos) if pedido else None)
    elegibles = [f for f in material if not producto or agente.normalizar(f["producto"]) == agente.normalizar(producto)]
    random.shuffle(elegibles)
    elegibles = elegibles[:6]

    lista = "\n".join('- id {} ({}): {}'.format(f["id"], "video" if (f.get("tipo") or "").startswith("video/") else "imagen", f["nombre"]) for f in elegibles)
    plan = agente.gemini("""{marca}

---
Sos el editor de video de {nombre}. Armá el guion de un Reel vertical de 15 a 25 segundos{sobre}.
Material disponible (podés repetir o no usar alguno):
{lista}
{aprendizajes}

Respondé SOLO un JSON:
- "tema": título interno corto
- "gancho": frase de máximo 6 palabras para los primeros 2 segundos (tiene que frenar el scroll)
- "escenas": de 4 a 6 escenas: [{{"material": "id de la lista o null", "texto": "máx. 9 palabras", "segundos": 2.5 a 4}}]
  (si no hay material, poné null y una "descripcion_imagen" EN INGLÉS para generarla con IA, sin texto en la imagen)
- "cierre": llamado a la acción de máximo 7 palabras para la placa final
- "caption": texto del Reel para Instagram (gancho en la primera línea, máx. 900 caracteres, sin markdown)
- "hashtags": 6 a 10 hashtags
Reglas: usá solo información de la marca; no inventes precios, premios ni cifras.""".format(
        marca=cliente["marca"], nombre=cliente["nombre"], lista=lista or "(no hay material: hay que generar imágenes)",
        sobre=" sobre: " + (pedido or producto) if (pedido or producto) else "",
        aprendizajes=texto_aprendizajes(trabajo.get("aprendizajes"))))

    porId = {f["id"]: f for f in elegibles}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        segmentos = []
        for i, esc in enumerate(plan["escenas"][:6]):
            seg = max(2.0, min(4.5, float(esc.get("segundos") or 3)))
            f = porId.get(esc.get("material"))
            gancho = plan["gancho"] if i == 0 else ""
            salida = str(tmp / "s{}.mp4".format(i))
            if f and (f.get("tipo") or "").startswith("video/"):
                origen = tmp / ("v" + f["id"])
                origen.write_bytes(hub("/api/agente/foto/" + f["id"]).content)
                total = duracion(str(origen))
                desde = random.uniform(0, max(0, total - seg - 0.5)) if total > seg + 1 else 0
                texto_transparente(esc.get("texto", ""), gancho, str(tmp / "t{}.png".format(i)))
                segmento_video(str(origen), desde, seg, str(tmp / "t{}.png".format(i)), salida)
            else:
                if f:
                    img = Image.open(io.BytesIO(hub("/api/agente/foto/" + f["id"]).content))
                else:
                    img = agente.generar_imagen(esc.get("descripcion_imagen") or plan["tema"])
                escena_png(img, esc.get("texto", ""), gancho, str(tmp / "e{}.jpg".format(i)))
                segmento_imagen(str(tmp / "e{}.jpg".format(i)), seg, salida, zoom_entrada=i % 2 == 0)
            segmentos.append(salida)
        placa_final(plan["cierre"], cliente["nombre"], str(tmp / "fin.jpg"))
        segmento_imagen(str(tmp / "fin.jpg"), 3.0, str(tmp / "fin.mp4"))
        segmentos.append(str(tmp / "fin.mp4"))

        (tmp / "lista.txt").write_text("".join("file '{}'\n".format(s) for s in segmentos))
        ffmpeg("-f", "concat", "-safe", "0", "-i", str(tmp / "lista.txt"), "-c", "copy", str(tmp / "imagen.mp4"))
        largo = duracion(str(tmp / "imagen.mp4"))
        final = str(tmp / "final.mp4")
        if musica:
            pista = tmp / "musica"
            pista.write_bytes(hub("/api/agente/foto/" + random.choice(musica)["id"]).content)
            ffmpeg("-i", str(tmp / "imagen.mp4"), "-stream_loop", "-1", "-i", str(pista), "-t", str(largo),
                   "-filter_complex", "[1:a]volume=0.7,afade=t=in:d=0.5,afade=t=out:st={}:d=1.5[a]".format(max(0, largo - 1.5)),
                   "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", final)
        else:  # Instagram prefiere que el Reel tenga pista de audio: va una silenciosa
            ffmpeg("-i", str(tmp / "imagen.mp4"), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", str(largo),
                   "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart", final)
        datos_video = Path(final).read_bytes()
        portada = io.BytesIO()
        Image.open(str(tmp / "e0.jpg") if (tmp / "e0.jpg").exists() else str(tmp / "fin.jpg")).convert("RGB").resize((540, 960)).save(portada, "JPEG", quality=85)

    print("Video: {:.1f} s, {:.1f} MB, {} escenas, música: {}".format(largo, len(datos_video) / 1e6, len(segmentos), "sí" if musica else "no"))
    if len(datos_video) > 24_000_000:
        raise RuntimeError("el video quedó muy pesado ({:.0f} MB)".format(len(datos_video) / 1e6))
    # el video y la portada viajan en binario (el hub no tiene que decodificar nada) y después los datos
    vid_id = "{}-v{}{}".format(cliente_id, base36(int(__import__("time").time() * 1000)), os.urandom(4).hex())
    for tipo, contenido in (("vid", datos_video), ("img", portada.getvalue())):
        r = requests.put("{}/api/agente/archivo/{}:{}".format(HUB, tipo, vid_id), data=contenido, headers=CLAVE, timeout=180)
        r.raise_for_status()
    hub("/api/agente/video", json={
        "cliente_id": cliente_id, "id": vid_id, "titulo": plan["tema"],
        "datos": {"caption": plan["caption"], "hashtags": plan["hashtags"], "producto": producto, "pedido": pedido, "segundos": round(largo, 1)},
    })


if __name__ == "__main__":
    args = sys.argv[1:] + ["", ""]
    try:
        generar(args[0], args[1].strip(), args[2].strip())
    except Exception as e:
        try:
            hub("/api/agente/aviso", json={"texto": "⚠️ No pude armar el video de {}: {}".format(args[0], e)})
        finally:
            raise
