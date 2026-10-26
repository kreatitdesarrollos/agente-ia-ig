-- Base de datos del hub (Cloudflare D1). Todo va separado por cliente.

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,                 -- corto, sin espacios: "kreatit"
  nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  marca TEXT NOT NULL DEFAULT '',      -- lo que antes era marca.md
  calendario TEXT NOT NULL DEFAULT '{}', -- lo que antes era calendario.json
  hora_post TEXT NOT NULL DEFAULT '09:00',
  zona TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  auto_publicar INTEGER NOT NULL DEFAULT 0,
  ig_user_id TEXT,
  ig_token TEXT,                       -- cifrado
  ig_token_renovado TEXT,
  ultimo_diario TEXT,                  -- fecha local del último post diario generado
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fotos y capturas por producto. El archivo va en KV (foto:<id>).
CREATE TABLE IF NOT EXISTS fotos (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  producto TEXT NOT NULL DEFAULT '',   -- "" = fotos propias sueltas (días con foto_propia)
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'image/png',
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS fotos_cliente ON fotos (cliente_id, producto);

-- La fila única de aprobación. Cada agente deja acá lo que quiere hacer.
CREATE TABLE IF NOT EXISTS propuestas (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'post',   -- post (más adelante: anuncio, respuesta, reseña...)
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | publicada | descartada | error
  titulo TEXT NOT NULL DEFAULT '',
  datos TEXT NOT NULL DEFAULT '{}',    -- json: caption, hashtags, foto_id, pedido...
  resultado TEXT,                      -- json: media_id, enlace o el error
  tg_message_id INTEGER,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS propuestas_estado ON propuestas (estado, cliente_id);

-- Registro de lo que pasa (para el panel y para depurar).
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id TEXT,
  tipo TEXT NOT NULL,
  detalle TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login del panel: código por Telegram y sesiones.
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  vence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codigos (
  codigo TEXT PRIMARY KEY,
  vence TEXT NOT NULL
);
