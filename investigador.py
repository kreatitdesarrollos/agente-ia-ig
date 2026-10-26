"""
Investigador de mercado (corre en GitHub Actions, workflow investigar.yml).

Busca en Google Noticias lo de la última semana sobre los temas y competidores de un cliente, y Gemini arma un
informe con novedades, competencia, tendencias, fechas e ideas de posts. Solo usa las noticias encontradas
(con sus links), nunca lo que "sabe" el modelo, para no inventar.

  python investigador.py <cliente>
"""
import html
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

import requests

import agente
from generador import hub


def noticias(consulta, dias=7, cantidad=6):
    url = "https://news.google.com/rss/search?q={}&hl=es-419&gl=AR&ceid=AR:es-419".format(
        urllib.parse.quote("{} when:{}d".format(consulta, dias)))
    r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    items = []
    for it in ET.fromstring(r.content).findall(".//item")[:cantidad]:
        fuente = it.findtext("source") or ""
        titulo = html.unescape(it.findtext("title") or "")
        if fuente and titulo.endswith(" - " + fuente):  # Google agrega " - Medio" al título
            titulo = titulo[: -len(" - " + fuente)]
        items.append({"titulo": titulo, "fuente": fuente, "fecha": (it.findtext("pubDate") or "")[:16],
                      "link": it.findtext("link") or ""})
    return items


def investigar(cliente_id):
    trabajo = hub("/api/agente/investigacion", params={"cliente": cliente_id}).json()
    cliente, config = trabajo["cliente"], trabajo["config"]
    consultas = [(q, "tema") for q in config.get("temas", [])[:6]] + \
                [(q, "competidor") for q in config.get("competidores", [])[:6]]
    if not consultas:
        raise RuntimeError("el cliente no tiene temas ni competidores cargados (panel → Investigación)")

    fuentes, vistos = [], set()
    for consulta, tipo in consultas:
        try:
            encontradas = noticias(consulta)
        except Exception as e:
            print("No pude buscar", consulta, e, file=sys.stderr)
            continue
        for n in encontradas:
            clave = re.sub(r"\W+", " ", n["titulo"].lower())[:80]
            if clave in vistos:
                continue
            vistos.add(clave)
            fuentes.append(dict(n, busqueda=consulta, tipo=tipo))
    fuentes = fuentes[:45]
    for i, n in enumerate(fuentes, 1):
        n["n"] = i

    lista = "\n".join("[{n}] {fecha} | {fuente} | {titulo} (búsqueda: {busqueda}, {tipo})".format(**n) for n in fuentes)
    datos = agente.gemini("""{marca}

---
Sos el investigador de mercado de {nombre}. Estas son las noticias REALES de la última semana sobre sus temas y
competidores (búsqueda en Google Noticias):

{lista}

Respondé SOLO con un JSON con estas claves:
- "resumen": 2 o 3 frases con lo más importante de la semana para este negocio
- "competencia": lista de lo que hicieron los competidores (vacía si no hay noticias de ellos)
- "tendencias": lista de tendencias u oportunidades del rubro
- "fechas": lista de fechas o eventos próximos que convenga aprovechar (vacía si no hay)
- "ideas": exactamente 5 ideas de posts para Instagram, cada una {{"titulo": "título corto, sin comandos", "enfoque": "qué decir y con qué gancho, en 1-2 frases", "fuentes": [números]}}

Reglas: usá SOLO estas noticias; no inventes hechos, cifras ni fechas. Cada punto termina con las fuentes entre
corchetes, ej. [3][7]. Las ideas tienen que conectar la noticia con los productos o servicios de la marca y servir
para su público. Si no hay noticias útiles, decilo en el resumen y proponé ideas evergreen marcándolas como tales.
Sin markdown.""".format(marca=cliente["marca"], nombre=cliente["nombre"], lista=lista or "(no se encontraron noticias)"))
    for idea in datos.get("ideas", []):  # a veces copia los comandos "/nuevo x — " de la marca en el título
        idea["titulo"] = re.sub(r"^\s*/nuevo\s+[^—–-]*[—–-]\s*", "", idea.get("titulo", "")).strip()
    datos["fuentes"] = fuentes
    hub("/api/agente/investigacion", json={"cliente_id": cliente_id, "datos": datos})
    print("Informe enviado:", len(fuentes), "noticias,", len(datos.get("ideas", [])), "ideas")


if __name__ == "__main__":
    try:
        investigar(sys.argv[1])
    except Exception as e:
        try:
            hub("/api/agente/aviso", json={"texto": "⚠️ No pude hacer la investigación de {}: {}".format(sys.argv[1], e)})
        finally:
            raise
