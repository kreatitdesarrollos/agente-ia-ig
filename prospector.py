"""
Agente Prospector (corre en GitHub Actions, workflow prospectar.yml).

  python prospector.py <cliente> buscar <prospeccion> [cantidad]  -> busca negocios en OpenStreetMap y escribe propuestas
  python prospector.py <cliente> escribir <prospeccion>           -> escribe propuestas para los prospectos nuevos (CSV)
  python prospector.py <cliente> ciclo                            -> lee respuestas y manda lo aprobado y los seguimientos
  python prospector.py <cliente> probar                           -> prueba la casilla de envío (SMTP e IMAP)

Los emails salen desde la casilla de prospección del cliente (un dominio aparte, no el principal), de a poco y con
pausas, siempre con link de baja. Quien responde pasa a ser lead en el hub.
"""
import email
import email.header
import email.utils
import html
import imaplib
import os
import random
import re
import smtplib
import sys
import time
from datetime import datetime, timedelta
from email.message import EmailMessage

import requests

import agente
from generador import hub

UA = {"User-Agent": "KreatitProspector/1.0 (+https://kreatit.com.ar)"}
PAUSA = os.environ.get("PAUSA_ENVIOS", "45-120")  # segundos entre emails (en pruebas se puede bajar)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
NO_SIRVE = re.compile(r"\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|ejemplo|tudominio|domain\.com", re.I)


# ---------------------------------------------------------------- buscar prospectos (OpenStreetMap)

def filtros_osm(rubro):
    r = agente.gemini("""Convertí este rubro de negocios en etiquetas de OpenStreetMap para buscarlos: "{}".
Respondé SOLO un JSON: {{"filtros": [["clave", "valor"], ...]}} con 1 a 6 pares exactos de OSM
(ej. hoteles: [["tourism","hotel"],["tourism","hostel"],["tourism","guest_house"]]; inmobiliarias: [["office","estate_agent"]];
gimnasios: [["leisure","fitness_centre"]]; sindicatos: [["office","union"]]).""".format(rubro))
    return [f for f in r.get("filtros", []) if isinstance(f, list) and len(f) == 2][:6]


def area_osm(zona):
    r = requests.get("https://nominatim.openstreetmap.org/search", params={"q": zona, "format": "json", "limit": 1},
                     headers=UA, timeout=30)
    r.raise_for_status()
    lugar = (r.json() or [None])[0]
    if not lugar:
        raise RuntimeError("no encontré la zona '{}' en el mapa".format(zona))
    base = {"relation": 3600000000, "way": 2400000000}.get(lugar["osm_type"])
    if base:
        return "area({})->.a;".format(base + int(lugar["osm_id"])), "(area.a)"
    s, n, o, e = lugar["boundingbox"]
    return "", "({},{},{},{})".format(s, o, n, e)


SERVIDORES_OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                      "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"]


def consultar_overpass(consulta, vueltas=4):
    """Los servidores públicos se saturan seguido: prueba todos, varias vueltas, esperando cada vez más."""
    for vuelta in range(vueltas):
        for url in SERVIDORES_OVERPASS:
            try:
                r = requests.post(url, data={"data": consulta}, headers=UA, timeout=120)
                if r.ok and r.headers.get("content-type", "").startswith("application/json"):
                    return r.json().get("elements", [])
                print("Overpass", url, r.status_code, file=sys.stderr)
            except requests.RequestException as e:
                print("Overpass", url, e, file=sys.stderr)
        time.sleep(45 * (vuelta + 1))
    return None


def buscar_nominatim(texto):
    r = requests.get("https://nominatim.openstreetmap.org/search", headers=UA, timeout=30, params={
        "q": texto, "format": "jsonv2", "limit": 50, "extratags": 1, "addressdetails": 1, "layer": "poi"})
    r.raise_for_status()
    return [{"tags": dict(x.get("extratags") or {}, name=x.get("name"), **{"addr:city": (x.get("address") or {}).get("city")})} for x in r.json()]


def textos_web(url, paginas=("", "contacto", "contact", "contactenos")):
    """Texto y emails de la web del negocio (portada y páginas de contacto)."""
    if not url.startswith("http"):
        url = "http://" + url
    base = url.rstrip("/")
    textos, emails = [], set()
    for p in paginas:
        try:
            r = requests.get(base + ("/" + p if p else ""), headers=UA, timeout=12)
            if not r.ok or "html" not in r.headers.get("content-type", ""):
                continue
        except requests.RequestException:
            continue
        crudo = r.text
        emails.update(m.lower() for m in EMAIL_RE.findall(html.unescape(crudo)) if not NO_SIRVE.search(m))
        limpio = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", crudo, flags=re.S | re.I)
        textos.append(re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", limpio))).strip())
    dominio = re.sub(r"^https?://(www\.)?", "", base).split("/")[0].lower()
    elegido = sorted(emails, key=lambda m: (not m.endswith("@" + dominio) and not m.endswith("." + dominio), len(m)))
    return " ".join(textos)[:4000], (elegido[0] if elegido else None)


def buscar(cliente_id, prospeccion_id, cantidad=20):
    t = hub("/api/agente/prospeccion/trabajo", params={"cliente": cliente_id, "prospeccion": prospeccion_id}).json()
    p, conocidos = t["prospeccion"], set(t["conocidos"])
    filtros = filtros_osm(p["rubro"] or p["nombre"])
    if not filtros:
        raise RuntimeError("no supe qué buscar para el rubro '{}'".format(p["rubro"]))
    area, donde = area_osm(p["zona"] or "Argentina")
    consulta = "[out:json][timeout:180];{}({});out center tags 5000;".format(
        area, "".join('nwr["{}"="{}"]{};'.format(k, v, donde) for k, v in filtros))
    elementos = consultar_overpass(consulta)
    if elementos is None:  # servidores saturados: último recurso, el buscador de OpenStreetMap
        elementos = buscar_nominatim("{} {}".format(p["rubro"] or p["nombre"], p["zona"] or ""))
    random.shuffle(elementos)
    print("OpenStreetMap:", len(elementos), "negocios para", filtros, "en", p["zona"])

    encontrados = []
    for el in elementos:
        if len(encontrados) >= cantidad:
            break
        tags = el.get("tags", {})
        nombre = tags.get("name")
        web = tags.get("website") or tags.get("contact:website") or tags.get("url")
        mail = (tags.get("email") or tags.get("contact:email") or "").split(";")[0].strip().lower() or None
        if not nombre or not (web or mail):
            continue
        if not mail and web:
            _, mail = textos_web(web)
        if not mail or mail in conocidos:
            continue
        conocidos.add(mail)
        encontrados.append({"nombre": nombre, "email": mail, "web": web, "fuente": "osm",
                            "telefono": tags.get("phone") or tags.get("contact:phone"), "ciudad": tags.get("addr:city")})
    print("Con email:", len(encontrados))
    hub("/api/agente/prospeccion/prospectos", json={"cliente_id": cliente_id, "prospeccion_id": prospeccion_id, "prospectos": encontrados})
    escribir(cliente_id, prospeccion_id)


# ---------------------------------------------------------------- escribir propuestas

def escribir(cliente_id, prospeccion_id):
    t = hub("/api/agente/prospeccion/trabajo", params={"cliente": cliente_id, "prospeccion": prospeccion_id}).json()
    cliente, p = t["cliente"], t["prospeccion"]
    nuevos = hub("/api/agente/prospeccion/nuevos", params={"cliente": cliente_id, "prospeccion": prospeccion_id, "limite": 15}).json()
    propuestas = []
    for x in nuevos:
        texto_web = textos_web(x["web"])[0] if x.get("web") else ""
        try:
            r = agente.gemini("""{marca}

---
Escribís un email de prospección B2B en nombre de {quien}, para un negocio que no nos conoce.
Qué ofrecemos en esta campaña: {oferta}
Link para probar: {link}

El negocio: {nombre} — web {web} — ciudad {ciudad}
Lo que dice su web (puede estar vacío): "{texto}"

Respondé SOLO con un JSON:
- "apto": false si claramente no es un negocio del rubro o no le serviría (ej. cerrado, otro rubro); si no, true
- "motivo": por qué no es apto (si apto es false)
- "resumen": qué es este negocio en una línea (para nuestro registro)
- "asunto": máximo 55 caracteres, específico para ellos, honesto (nada de "RE:" falso, mayúsculas ni signos de más)
- "cuerpo": texto plano de 70 a 130 palabras: saludo dirigido a {nombre}; UNA observación concreta y real de su web
  (si no hay datos, no inventes: hablá del rubro); cómo los ayuda lo que ofrecemos, en beneficios; invitación clara y
  sin presión a probar la demo en {link} (si la oferta trae datos de acceso a la demo, como usuario y contraseña,
  copialos exactos en una línea aparte); cierre con una pregunta simple. Sin firma (se agrega sola), sin markdown,
  sin precios ni datos que no estén en la información de la marca, y sin inventar condiciones de la prueba
  (tarjeta, días gratis, plazos) que no figuren en la oferta.""".format(
                marca=cliente["marca"], quien=cliente["nombre"], oferta=p["oferta"], link=p["link"] or "",
                nombre=x["nombre"] or "el equipo", web=x.get("web") or "-", ciudad=x.get("ciudad") or "-", texto=texto_web[:3000]))
        except Exception as e:
            print("Gemini no respondió para", x["email"], e, file=sys.stderr)
            continue
        if r.get("apto") is False:
            propuestas.append({"prospecto_id": x["id"], "descartar": True, "motivo": r.get("motivo"), "resumen": r.get("resumen")})
        else:
            propuestas.append({"prospecto_id": x["id"], "resumen": r.get("resumen"), "asunto": r.get("asunto"), "cuerpo": r.get("cuerpo")})
    hub("/api/agente/prospeccion/propuestas", json={"prospeccion_id": prospeccion_id, "propuestas": propuestas})
    print("Propuestas escritas:", sum(1 for x in propuestas if not x.get("descartar")), "· descartados:", sum(1 for x in propuestas if x.get("descartar")))


# ---------------------------------------------------------------- casilla: enviar y leer respuestas

def conectar_smtp(c):
    if int(c.get("smtp_puerto") or 465) == 465:
        s = smtplib.SMTP_SSL(c["smtp_host"], 465, timeout=60)
    else:
        s = smtplib.SMTP(c["smtp_host"], int(c["smtp_puerto"]), timeout=60)
        s.starttls()
    s.login(c["usuario"], c["clave"])
    return s


def mensaje(c, para, asunto, cuerpo, baja, responde_a=None):
    m = EmailMessage()
    m["From"] = email.utils.formataddr((c.get("remitente") or "", c["usuario"]))
    m["To"] = para
    m["Subject"] = asunto
    m["Message-ID"] = email.utils.make_msgid(domain=c["usuario"].split("@")[1])
    m["Date"] = email.utils.formatdate(localtime=True)
    m["List-Unsubscribe"] = "<{}>, <mailto:{}?subject=baja>".format(baja, c["usuario"])
    m["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    if responde_a:
        m["In-Reply-To"] = responde_a
        m["References"] = responde_a
    firma = "\n\n" + c["firma"] if c.get("firma") else ""
    m.set_content("{}{}\n\n—\nSi preferís que no te escribamos más: {}".format(cuerpo.strip(), firma, baja))
    return m


def seguimiento(cliente, x):
    ultimo = x["paso"] >= 2
    r = agente.gemini("""Escribís el seguimiento {n} de un email de prospección que {nombre} no respondió.
Email anterior:
"{anterior}"
Respondé SOLO un JSON {{"cuerpo": "..."}}: 35 a 70 palabras, amable y breve, sin culpar por no responder, aportando
algo nuevo o recordando el beneficio principal y el link {link}. {cierre} Sin firma, sin markdown.""".format(
        n=x["paso"], nombre=x["nombre"] or "el negocio", anterior=(x.get("anterior") or "")[:1500], link=x.get("link") or "",
        cierre="Es el último: avisá con buena onda que no vas a volver a escribir." if ultimo else ""))
    return r["cuerpo"]


def leer_respuestas(c, enviados):
    """Busca en la bandeja respuestas, rebotes y pedidos de baja de los últimos 21 días."""
    por_email = {e["email"].lower(): e for e in enviados}
    por_mid = {e["message_id"]: e for e in enviados if e.get("message_id")}
    if not por_email:
        return []
    imap = imaplib.IMAP4_SSL(c["imap_host"], 993)
    imap.login(c["usuario"], c["clave"])
    imap.select("INBOX", readonly=True)
    desde = (datetime.utcnow() - timedelta(days=21)).strftime("%d-%b-%Y")
    _, ids = imap.search(None, "SINCE", desde)
    eventos = []
    for num in ids[0].split()[-300:]:
        _, data = imap.fetch(num, "(RFC822)")
        msg = email.message_from_bytes(data[0][1])
        de = email.utils.parseaddr(msg.get("From", ""))[1].lower()
        refs = " ".join([msg.get("In-Reply-To", ""), msg.get("References", "")])
        cuerpo = ""
        for parte in (msg.walk() if msg.is_multipart() else [msg]):
            if parte.get_content_type() == "text/plain":
                cuerpo = (parte.get_payload(decode=True) or b"").decode(parte.get_content_charset() or "utf-8", "replace")
                break
        asunto = str(email.header.make_header(email.header.decode_header(msg.get("Subject", ""))))
        if re.search(r"mailer-daemon|postmaster", de) or re.search(r"undeliver|delivery status|no se pudo entregar|failure notice", asunto, re.I):
            for direccion in por_email:
                if direccion in cuerpo.lower():
                    eventos.append({"email": direccion, "tipo": "rebote"})
            continue
        prospecto = por_email.get(de) or next((e for mid, e in por_mid.items() if mid and mid in refs), None)
        if not prospecto:
            continue
        nuevo = cuerpo.split("\nEl ")[0].split("\nOn ")[0].strip()  # sin el texto citado
        tipo = "baja" if re.search(r"dar(me)? de baja|no me (escriban|manden|env[ií]en)|unsubscribe|remove me|no quiero recibir", nuevo, re.I) else "respuesta"
        eventos.append({"email": prospecto["email"], "tipo": tipo, "asunto": asunto, "texto": nuevo[:3000]})
    imap.logout()
    return eventos


def ciclo(cliente_id):
    datos = hub("/api/agente/prospeccion/envios", params={"cliente": cliente_id}).json()
    c, cola = datos["correo"], datos["cola"]
    try:
        eventos = leer_respuestas(c, datos["enviados"])
        if eventos:
            hub("/api/agente/prospeccion/respuestas", json={"cliente_id": cliente_id, "eventos": eventos})
            respondieron = {e["email"] for e in eventos}
            cola = [x for x in cola if x["email"] not in respondieron]
        print("Respuestas/rebotes/bajas:", len(eventos))
    except Exception as e:
        print("No pude leer la casilla:", e, file=sys.stderr)
    if not cola:
        print("Nada para enviar ahora")
        return
    smtp = conectar_smtp(c)
    pausa = [int(n) for n in PAUSA.split("-")]
    for i, x in enumerate(cola):
        try:
            if x["paso"] == 0:
                asunto, cuerpo, hilo = x["asunto"], x["cuerpo"], None
            else:
                asunto, cuerpo, hilo = "Re: " + (x["asunto"] or ""), seguimiento(datos["cliente"], x), x["message_id"]
            m = mensaje(c, x["email"], asunto, cuerpo, x["baja"], hilo)
            smtp.send_message(m)
            hub("/api/agente/prospeccion/enviado", json={"prospecto_id": x["id"], "paso": x["paso"], "asunto": asunto, "cuerpo": cuerpo,
                                                        "message_id": m["Message-ID"], "ok": True})
            print("Enviado", x["paso"], "→", x["email"])
        except smtplib.SMTPRecipientsRefused as e:
            hub("/api/agente/prospeccion/enviado", json={"prospecto_id": x["id"], "paso": x["paso"], "ok": False, "rechazado": True, "detalle": str(e)[:300]})
        except Exception as e:
            hub("/api/agente/prospeccion/enviado", json={"prospecto_id": x["id"], "paso": x["paso"], "ok": False, "detalle": str(e)[:300]})
            print("Error enviando a", x["email"], e, file=sys.stderr)
        if i < len(cola) - 1:
            time.sleep(random.randint(*pausa))
    smtp.quit()


def probar(cliente_id):
    datos = hub("/api/agente/prospeccion/envios", params={"cliente": cliente_id}).json()
    c, partes = datos["correo"], []
    try:
        conectar_smtp(c).quit()
        partes.append("✅ envío (SMTP) OK")
    except Exception as e:
        partes.append("⚠️ envío (SMTP): {}".format(e))
    try:
        imap = imaplib.IMAP4_SSL(c["imap_host"], 993)
        imap.login(c["usuario"], c["clave"])
        imap.logout()
        partes.append("✅ lectura de respuestas (IMAP) OK")
    except Exception as e:
        partes.append("⚠️ lectura (IMAP): {}".format(e))
    hub("/api/agente/aviso", json={"texto": "📨 Casilla de prospección de {} ({}):\n{}".format(datos["cliente"]["nombre"], c["usuario"], "\n".join(partes))})


if __name__ == "__main__":
    cliente, accion = sys.argv[1], sys.argv[2]
    try:
        if accion == "buscar":
            buscar(cliente, sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 20)
        elif accion == "escribir":
            escribir(cliente, sys.argv[3])
        elif accion == "ciclo":
            ciclo(cliente)
        elif accion == "probar":
            probar(cliente)
    except Exception as e:
        try:
            hub("/api/agente/aviso", json={"texto": "⚠️ Prospector ({}, {}): {}".format(cliente, accion, e)})
        finally:
            raise
