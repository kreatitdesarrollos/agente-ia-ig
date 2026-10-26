"""
Generador de posts del hub (corre en GitHub Actions, workflow generar.yml).

Le pide al hub la configuración del cliente (marca, calendario, fotos, historial), arma el texto con Gemini y la
imagen, y le devuelve la propuesta. El hub se encarga de mandarla a Telegram/panel y de publicarla.

  python generador.py <cliente> [pedido] [producto]
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

import requests
from PIL import Image

import agente  # la IA de texto e imagen es la misma del agente original

HUB = os.environ.get("HUB_URL", "").rstrip("/")
CLAVE = {"X-Clave": hashlib.sha256(os.environ.get("TELEGRAM_TOKEN", "").encode()).hexdigest()}


def hub(ruta, **kwargs):
    metodo = "POST" if "json" in kwargs else "GET"
    r = requests.request(metodo, HUB + ruta, headers=CLAVE, timeout=120, **kwargs)
    r.raise_for_status()
    return r


def producto_de(pedido, productos):
    """El producto cuyo nombre está en el pedido (todas sus palabras); si hay varios, el más específico."""
    palabras = set(re.findall(r"\w+", agente.normalizar(pedido)))
    candidatos = [p for p in productos if set(re.findall(r"\w+", agente.normalizar(p))) <= palabras]
    return max(candidatos, key=lambda p: len(p.split()), default=None)


def producto_que_toca(nombres, historial):
    """De los productos del calendario, el que hace más tiempo que no sale."""
    ultimo = {agente.normalizar(h["producto"]): i for i, h in enumerate(historial) if h.get("producto")}
    return min(nombres, key=lambda n: ultimo.get(agente.normalizar(n), -1))


def foto_menos_usada(fotos, historial):
    ultimo = {h.get("foto_id"): i for i, h in enumerate(historial)}
    return min(fotos, key=lambda f: ultimo.get(f["id"], -1), default=None)


def texto_aprendizajes(a):
    """Lo que funcionó y lo que no en Instagram, para que Gemini lo tenga en cuenta (sin copiar textos)."""
    if not a or not a.get("mejores"):
        return ""
    linea = lambda p: '- "{}" (alcance {}, interacciones {}, guardados {})'.format(
        p["texto"], p.get("alcance") or "?", p.get("interacciones") or "?", p.get("guardados") or "?")
    texto = "\n\nLo que MEJOR funcionó en Instagram últimamente:\n" + "\n".join(map(linea, a["mejores"]))
    if a.get("peores"):
        texto += "\nLo que PEOR funcionó:\n" + "\n".join(map(linea, a["peores"]))
    if a.get("recomendaciones"):
        texto += "\nÚltimo informe semanal:\n" + a["recomendaciones"][:1500]
    return texto + "\nUsá esto para elegir el enfoque, el gancho y el formato (sin copiar textos ni repetir temas)."


def generar(cliente_id, pedido="", producto=""):
    trabajo = hub("/api/agente/trabajo", params={"cliente": cliente_id}).json()
    cliente, fotos, historial = trabajo["cliente"], trabajo["fotos"], trabajo["historial"]
    agente.ZONA = ZoneInfo(cliente["zona"])
    calendario = json.loads(cliente["calendario"] or "{}")
    dia = calendario.get(agente.DIAS[agente.ahora().weekday()], {"tipo": "post libre sobre los servicios de la empresa"})
    productos = sorted({f["producto"] for f in fotos if f["producto"]})

    if pedido or producto:  # pedido por Telegram o el panel: manda sobre el calendario
        producto = producto or producto_de(pedido, productos)
        tipo = 'post a pedido del dueño: "{}". Si menciona un producto propio, usá la info de "Nuestros productos" ' \
               'y no inventes datos que no estén ahí.'.format(pedido or producto)
        if producto:
            tipo += ' Es el producto que figura con "/nuevo {}" en "Nuestros productos".'.format(producto)
    elif dia.get("productos"):
        disponibles = [p for p in dia["productos"] if agente.normalizar(p) in map(agente.normalizar, productos)]
        producto = producto_que_toca(disponibles, historial) if disponibles else None
        tipo = dia["tipo"]
        if producto:
            tipo += ' Hoy el post es sobre el producto que figura con "/nuevo {}" en "Nuestros productos" (usá su ' \
                    'info y no inventes datos que no estén ahí).'.format(producto)
    else:
        tipo = dia["tipo"]

    foto = None
    if producto:
        foto = foto_menos_usada([f for f in fotos if agente.normalizar(f["producto"]) == agente.normalizar(producto)], historial)
    elif dia.get("foto_propia") and not pedido:
        usadas = {h.get("foto_id") for h in historial}
        foto = next((f for f in fotos if not f["producto"] and f["id"] not in usadas), None)

    temas = [h["titulo"] for h in historial]
    tipo += texto_aprendizajes(trabajo.get("aprendizajes"))
    if foto and producto:  # app o juego: pieza publicitaria con la captura real
        captura = Image.open(io.BytesIO(hub("/api/agente/foto/" + foto["id"]).content))
        buf = io.BytesIO()
        captura.convert("RGB").save(buf, "JPEG", quality=85)
        datos = agente.pedir_texto(tipo, temas, buf.getvalue(), pieza=True, marca=cliente["marca"])
        try:
            fondo = agente.generar_imagen(datos["prompt_imagen"])
        except Exception as e:  # sin fondo IA queda un degradado con los colores de la marca
            print("No se pudo generar el fondo:", e, file=sys.stderr)
            fondo = None
        img = agente.pieza_publicitaria(captura, fondo, datos.get("titular", ""), datos.get("bajada", ""),
                                        datos.get("boton") or "Descargalo gratis")
    elif foto:  # foto propia
        img = agente.ajustar_imagen(Image.open(io.BytesIO(hub("/api/agente/foto/" + foto["id"]).content)))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        datos = agente.pedir_texto(tipo, temas, buf.getvalue(), marca=cliente["marca"])
    else:
        datos = agente.pedir_texto(tipo, temas, marca=cliente["marca"])
        img = agente.ajustar_imagen(agente.generar_imagen(datos["prompt_imagen"]))

    salida = io.BytesIO()
    img.save(salida, "JPEG", quality=90)
    respuesta = hub("/api/agente/propuesta", json={
        "cliente_id": cliente["id"],
        "titulo": datos["tema"],
        "datos": {"caption": datos["caption"], "hashtags": datos["hashtags"], "foto_id": foto["id"] if foto else None,
                  "producto": producto or None, "pedido": pedido},
        "imagen_b64": base64.b64encode(salida.getvalue()).decode(),
    }).json()
    print("Propuesta creada:", respuesta.get("id"), "-", datos["tema"])


if __name__ == "__main__":
    args = sys.argv[1:] + ["", ""]
    try:
        generar(args[0], args[1].strip(), args[2].strip())
    except Exception as e:
        try:
            hub("/api/agente/aviso", json={"texto": "⚠️ No pude generar el post de {}: {}".format(args[0], e)})
        finally:
            raise
