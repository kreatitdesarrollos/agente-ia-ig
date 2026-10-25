# Agente de Instagram — Kreatit

Todos los días a las 9:00 (Argentina) el agente:
1. Elige el tipo de post según el día (`calendario.json`).
2. Escribe el texto con IA (Gemini) usando la info de `marca.md`.
3. Genera la imagen con IA (Cloudflare FLUX) o usa una foto tuya de `fotos/`.
4. Te la manda por **Telegram** con botones: ✅ Publicar · 🔄 Otra · ❌ Descartar.
   - Si respondés con texto, ese texto reemplaza el caption.
   - `/nuevo` genera un post extra en cualquier momento.
5. Cuando aprobás, lo publica en Instagram (en ≤15 min) y te manda el link.

Todo corre gratis en GitHub Actions. Costo: $0.

---

## Configuración (una sola vez, ~1 hora)

### 1. Instagram + Meta (lo más largo)
1. En la app de Instagram: **Configuración → Tipo de cuenta → Cambiar a cuenta profesional** (Empresa).
2. Entrá a https://developers.facebook.com → **Mis apps → Crear app**.
   - Caso de uso: **"Administrar mensajes y contenido en Instagram"**.
3. En la app: **Instagram → Configuración de la API con inicio de sesión de Instagram**.
4. En **"Generar tokens de acceso"** → **Agregar cuenta** → iniciá sesión con el Instagram de Kreatit
   y aceptá los permisos (`instagram_business_basic`, `instagram_business_content_publish`).
5. Copiá el **token** que te muestra → será el secreto `IG_TOKEN`.
   (Mientras la app esté en modo desarrollo funciona para tus propias cuentas, no hace falta revisión de Meta.)
### 2. Gemini (texto) — gratis
https://aistudio.google.com/apikey → **Crear clave de API** → secreto `GEMINI_API_KEY`.
### 3. Cloudflare (imágenes) — gratis
1. Creá cuenta en https://dash.cloudflare.com.
2. El **Account ID** aparece en la barra lateral de "Workers AI" (o en la URL) → secreto `CF_ACCOUNT_ID`.
3. **Mi perfil → Tokens de API → Crear token → plantilla "Workers AI"** → secreto `CF_API_TOKEN`.
### 4. Bot de Telegram — gratis
1. En Telegram hablale a **@BotFather** → `/newbot` → copiá el token → secreto `TELEGRAM_TOKEN`.
2. Mandale cualquier mensaje a tu bot y abrí en el navegador:
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` → buscá `"chat":{"id": 123456...}` → secreto `TELEGRAM_CHAT_ID`.
### 5. GitHub
1. Creá un repo **público** (necesario para que Actions sea gratis ilimitado y para que Instagram
   pueda descargar las imágenes) y subí esta carpeta.
   https://github.com/kreatitdesarrollos/agente-ia-ig.git
2. **Settings → Secrets and variables → Actions → New repository secret** y cargá:
   `GEMINI_API_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `IG_TOKEN`.
3. Pestaña **Actions → Agente Instagram → Run workflow** con comando `verificar`.
   En el log vas a ver tu `user_id` de Instagram → cargalo como secreto `IG_USER_ID`.
4. **Run workflow** con `generar` → te tiene que llegar el post a Telegram. 🎉

> Los secretos quedan cifrados: aunque el repo sea público, nadie puede verlos.

### 6. Renovación automática del token (recomendado)
El token de Instagram vence a los 60 días. El agente lo renueva solo el día 1 de cada mes si cargás
el secreto `GH_PAT`:
GitHub → **Settings (de tu perfil) → Developer settings → Fine-grained tokens → Generate** →
solo este repo → permiso **Secrets: Read and write**.

---

## Uso diario

| Querés... | Hacé esto |
|---|---|
| Cambiar qué se publica cada día | Editá `calendario.json` |
| Cambiar tono, servicios, hashtags | Editá `marca.md` |
| Usar fotos propias | Subilas a `fotos/` (se usan los días con `"foto_propia": true`, una vez cada una) |
| Poner tu logo en las imágenes | Subí `logo.png` (fondo transparente) a la raíz |
| Cambiar la hora | Editá el primer `cron` en `.github/workflows/agente.yml` (está en hora UTC) |
| **Que publique solo, sin aprobar** | Settings → Secrets and variables → Actions → **Variables** → `AUTO_PUBLICAR` = `true` |

Notas:
- Los horarios de GitHub Actions pueden atrasarse unos minutos, es normal.
- Si un día los días con foto propia no tienen fotos nuevas, usa una imagen IA.
