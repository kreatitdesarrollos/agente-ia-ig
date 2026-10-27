"""
Agente de seguridad: chequeo diario profundo (corre en GitHub Actions, workflow seguridad.yml).

Solo chequeos pasivos sobre los sitios que cada cliente registró como propios:
  - certificado SSL: que sea válido y cuántos días faltan para que venza
  - archivos que nunca deberían ser públicos (.env, .git, logs de Laravel, phpinfo...)
  - email del dominio: SPF, DMARC y MX bien armados
  - claves filtradas en este repositorio (archivos actuales e historial de commits)

  python seguridad.py [cliente]
"""
import os
import re
import socket
import ssl
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests

from generador import hub

UA = {"User-Agent": "KreatitSeguridad/1.0 (monitoreo de sitios propios)"}

# ruta → qué tiene que aparecer en la respuesta para estar seguros de que el archivo está expuesto
# (muchos sitios responden 200 con su página de inicio para cualquier ruta)
ARCHIVOS = {
    "/.env": r"APP_KEY=|DB_PASSWORD=|DB_USERNAME=|SECRET",
    "/backend/.env": r"APP_KEY=|DB_PASSWORD=|DB_USERNAME=",
    "/.git/HEAD": r"^ref: refs/",
    "/.git/config": r"\[core\]",
    "/storage/logs/laravel.log": r"\[\d{4}-\d{2}-\d{2} [\d:]+\] \w+\.(ERROR|INFO|DEBUG|WARNING)",
    "/backend/storage/logs/laravel.log": r"\[\d{4}-\d{2}-\d{2} [\d:]+\] \w+\.(ERROR|INFO|DEBUG|WARNING)",
    "/composer.lock": r'"content-hash"',
    "/composer.json": r'"require"\s*:',
    "/package.json": r'"(dev)?[dD]ependencies"\s*:',
    "/artisan": r"Illuminate|LARAVEL_START",
    "/phpinfo.php": r"phpinfo\(\)|PHP Version",
    "/.DS_Store": r"Bud1",
    "/wp-config.php.bak": r"DB_PASSWORD",
}

SECRETOS = {
    "token de Instagram": r"IGAA[A-Za-z0-9_-]{60,}",
    "token de Facebook/Meta": r"\bEAA[A-Za-z0-9]{80,}",
    "clave de Google/Gemini": r"\bAIza[0-9A-Za-z_-]{35}\b|\bAQ\.[A-Za-z0-9_-]{40,}",
    "token de bot de Telegram": r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b",
    "token de GitHub": r"\b(ghp|gho|github_pat)_[A-Za-z0-9_]{30,}",
    "token de Cloudflare": r"\bcfut_[A-Za-z0-9]{30,}",
    "clave de Brevo": r"\bxkeysib-[a-f0-9]{60,}",
    "clave de AWS": r"\bAKIA[0-9A-Z]{16}\b",
    "clave privada": r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
}

NO_PROPIOS = (".workers.dev", ".pages.dev", ".github.io", ".netlify.app", ".vercel.app")


def certificado(host):
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=10) as s, ctx.wrap_socket(s, server_hostname=host) as t:
            vence = datetime.strptime(t.getpeercert()["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        dias = (vence - datetime.now(timezone.utc)).days
        nivel = "critico" if dias < 7 else "aviso" if dias < 21 else "ok"
        return nivel, "El certificado SSL vence en {} días ({}).".format(dias, vence.date())
    except ssl.SSLCertVerificationError as e:
        return "critico", "El certificado SSL no es válido: {}".format(e.verify_message or e)
    except Exception as e:
        return "aviso", "No pude revisar el certificado: {}".format(e)


def archivos_expuestos(base):
    expuestos = []
    for ruta, firma in ARCHIVOS.items():
        try:
            r = requests.get(base + ruta, headers=UA, timeout=12, allow_redirects=False)
        except requests.RequestException:
            continue
        if r.status_code == 200 and re.search(firma, r.text[:20000], re.M):
            expuestos.append(ruta)
    if expuestos:
        return "critico", "Archivos privados que cualquiera puede descargar: " + ", ".join(expuestos)
    return "ok", "No hay archivos privados expuestos (revisados: {}).".format(", ".join(ARCHIVOS))


def dns(nombre, tipo):
    r = requests.get("https://cloudflare-dns.com/dns-query", params={"name": nombre, "type": tipo},
                     headers={"accept": "application/dns-json"}, timeout=15)
    return [a.get("data", "").strip('"').replace('" "', "") for a in r.json().get("Answer", []) or []]


def dominio_raiz(host):
    partes = host.lower().removeprefix("www.").split(".")
    return ".".join(partes[-3:] if len(partes) >= 3 and partes[-2] in ("com", "gob", "org", "net", "edu") and len(partes[-1]) == 2 else partes[-2:])


def email_del_dominio(dominio):
    problemas, notas = [], []
    spf = [t for t in dns(dominio, "TXT") if t.lower().startswith("v=spf1")]
    if not spf:
        problemas.append("no tiene registro SPF")
    elif len(spf) > 1:
        problemas.append("tiene {} registros SPF (tiene que haber uno solo)".format(len(spf)))
    elif "+all" in spf[0]:
        return "critico", "El SPF termina en +all: cualquiera puede mandar emails haciéndose pasar por {}.".format(dominio)
    dmarc = [t for t in dns("_dmarc." + dominio, "TXT") if t.lower().startswith("v=dmarc1")]
    if not dmarc:
        problemas.append("no tiene DMARC")
    else:
        for tag in ("rua", "ruf"):
            m = re.search(tag + r"=([^;]+)", dmarc[0])
            if m:
                malas = [d.strip() for d in m.group(1).split(",") if not d.strip().lower().startswith("mailto:")]
                if malas:
                    problemas.append("en el DMARC, {} tiene direcciones sin 'mailto:' ({})".format(tag, ", ".join(malas)))
        if re.search(r"p=none", dmarc[0]):
            notas.append("DMARC en modo monitoreo (p=none)")
    if not dns(dominio, "MX"):
        problemas.append("no tiene registros MX (no recibe emails)")
    if problemas:
        return "aviso", "{}: {}.".format(dominio, "; ".join(problemas))
    return "ok", "{}: SPF, DMARC y MX bien{}.".format(dominio, " — " + ", ".join(notas) if notas else "")


def secretos_en_repo():
    """Busca claves en los archivos del repositorio y en todo su historial (lo borrado sigue en los commits viejos)."""
    en_archivos = {}  # valor → dónde está
    for raiz, dirs, archivos in os.walk("."):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".venv")]
        for a in archivos:
            ruta = os.path.join(raiz, a)
            if os.path.getsize(ruta) > 1_000_000:
                continue
            try:
                texto = open(ruta, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            for nombre, patron in SECRETOS.items():
                for m in re.finditer(patron, texto):
                    en_archivos[m.group(0)] = "{} en {}".format(nombre, ruta[2:])
    en_historia = {}
    try:
        historia = subprocess.run(["git", "log", "-p", "--all", "--no-color"], capture_output=True, text=True, timeout=300).stdout
        for nombre, patron in SECRETOS.items():
            for m in re.finditer(patron, historia):
                if m.group(0) not in en_archivos:
                    en_historia[m.group(0)] = "{} en un commit viejo".format(nombre)
    except Exception as e:
        print("No pude revisar el historial:", e, file=sys.stderr)
    hallados = ["{} ({}…)".format(donde, valor[:6]) for valor, donde in {**en_archivos, **en_historia}.items()]
    if hallados:
        return "critico", "Claves expuestas en el repositorio público: " + "; ".join(sorted(hallados)[:10])
    return "ok", "No hay claves expuestas en el repositorio (archivos e historial)."


def main(solo_cliente=""):
    datos = hub("/api/agente/seguridad/activos").json()
    resultados, dominios = [], {}
    for a in datos["activos"]:
        if solo_cliente and a["cliente_id"] != solo_cliente:
            continue
        u = urlparse(a["url"])
        base = "{}://{}".format(u.scheme, u.netloc)
        if u.scheme == "https":
            nivel, detalle = certificado(u.hostname)
            resultados.append({"cliente_id": a["cliente_id"], "activo": a["url"], "chequeo": "certificado", "nivel": nivel, "detalle": detalle})
        nivel, detalle = archivos_expuestos(base)
        resultados.append({"cliente_id": a["cliente_id"], "activo": a["url"], "chequeo": "archivos", "nivel": nivel, "detalle": detalle})
        if not u.hostname.endswith(NO_PROPIOS):
            dominios.setdefault((a["cliente_id"], dominio_raiz(u.hostname)), True)
        print(a["url"], "revisado")
    for (cliente, dominio) in dominios:
        try:
            nivel, detalle = email_del_dominio(dominio)
        except Exception as e:
            nivel, detalle = "aviso", "No pude revisar el DNS de {}: {}".format(dominio, e)
        resultados.append({"cliente_id": cliente, "activo": dominio, "chequeo": "email", "nivel": nivel, "detalle": detalle})
    if not solo_cliente or solo_cliente == datos["agencia"]:
        nivel, detalle = secretos_en_repo()
        resultados.append({"cliente_id": datos["agencia"], "activo": "repositorio", "chequeo": "secretos", "nivel": nivel, "detalle": detalle})
    hub("/api/agente/seguridad/resultados", json={"resultados": resultados})
    for r in resultados:
        print(r["nivel"].upper().ljust(8), r["activo"], "·", r["chequeo"], "·", r["detalle"][:150])


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
