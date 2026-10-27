"""
Redactor SEO (corre en GitHub Actions, workflow seo.yml).

Mira qué busca la gente en Google sobre los temas del cliente (sugerencias del buscador), elige una búsqueda que
todavía no cubrió y escribe un artículo para su blog. Vuelve al hub como propuesta para aprobar; al aprobarse,
se publica en su WordPress (si lo conectó) o en una página del hub.

  python seo.py <cliente> [tema]
"""
import re
import sys

import requests

import agente
from generador import hub


def sugerencias(consulta):
    try:
        r = requests.get("https://suggestqueries.google.com/complete/search",
                         params={"client": "firefox", "hl": "es", "gl": "ar", "q": consulta}, timeout=15)
        return [s for s in r.json()[1] if s.lower() != consulta.lower()][:8]
    except Exception as e:
        print("Sin sugerencias para", consulta, e, file=sys.stderr)
        return []


def slug(texto):
    t = agente.normalizar(texto)
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:70]


def escribir(cliente_id, tema=""):
    t = hub("/api/agente/seo", params={"cliente": cliente_id}).json()
    cliente, temas, previos = t["cliente"], t["temas"], t["previos"]
    semillas = [tema] if tema else temas[:5]
    if not semillas:
        raise RuntimeError("el cliente no tiene temas cargados para el blog (panel → Mi cuenta → Blog)")
    busquedas = []
    for s in semillas:
        busquedas += [s] + sugerencias(s)
    busquedas = list(dict.fromkeys(busquedas))[:30]

    a = agente.gemini("""{marca}

---
Sos el redactor SEO de {nombre}. Estas son búsquedas reales que hace la gente en Google (Argentina):
{busquedas}

Artículos que ya escribimos (no repetir el tema): {previos}

Elegí UNA búsqueda que le sirva al negocio (gente que podría convertirse en cliente) y escribí el artículo.
Respondé SOLO un JSON:
- "palabra_clave": la búsqueda elegida
- "titulo": máx. 60 caracteres, con la palabra clave, atractivo y honesto
- "meta_descripcion": máx. 155 caracteres
- "html": el artículo en HTML simple (solo <h2>, <h3>, <p>, <ul>, <li>, <strong>, <a>), de 900 a 1300 palabras,
  útil de verdad (que responda la búsqueda), con la palabra clave en el primer párrafo y en algún subtítulo, ejemplos
  concretos, y al final un llamado a la acción hacia el producto o servicio de la marca. Sin <h1> (el título va aparte).
- "preguntas": 3 preguntas frecuentes con su respuesta corta [{{"p": "...", "r": "..."}}]
Reglas: no inventes estadísticas, precios, clientes ni estudios; si das un dato general, que sea de conocimiento
común. Español rioplatense neutro, frases claras.""".format(
        marca=cliente["marca"], nombre=cliente["nombre"], busquedas="\n".join("- " + b for b in busquedas),
        previos=", ".join(previos) or "ninguno"))
    html = a["html"]
    if a.get("preguntas"):
        html += "<h2>Preguntas frecuentes</h2>" + "".join("<h3>{}</h3><p>{}</p>".format(q["p"], q["r"]) for q in a["preguntas"])
    palabras = len(re.sub(r"<[^>]+>", " ", html).split())
    hub("/api/agente/articulo", json={"cliente_id": cliente_id, "titulo": a["titulo"], "datos": {
        "titulo": a["titulo"], "meta": a["meta_descripcion"], "palabra_clave": a["palabra_clave"], "slug": slug(a["titulo"]),
        "html": html, "palabras": palabras, "texto": re.sub(r"<[^>]+>", " ", html)}})
    print("Artículo:", a["titulo"], "·", palabras, "palabras · palabra clave:", a["palabra_clave"])


if __name__ == "__main__":
    args = sys.argv[1:] + [""]
    try:
        escribir(args[0], args[1].strip())
    except Exception as e:
        try:
            hub("/api/agente/aviso", json={"texto": "⚠️ No pude escribir el artículo del blog de {}: {}".format(args[0], e)})
        finally:
            raise
