-- Usuarios con roles: la agencia ve todo; cada cliente ve solo lo suyo.

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE,          -- con lo que entra al panel (email o alias)
  rol TEXT NOT NULL DEFAULT 'cliente',   -- agencia | cliente
  cliente_id TEXT,                       -- null para la agencia
  tg_chat TEXT UNIQUE,                   -- se completa cuando acepta la invitación en Telegram
  invitacion TEXT UNIQUE,
  recibe_previas INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

-- vos, ya vinculado al chat de Telegram de siempre
INSERT OR IGNORE INTO usuarios (id, nombre, usuario, rol, tg_chat) VALUES ('agencia', 'Agencia Kreatit', 'admin', 'agencia', '5869660961');

DROP TABLE IF EXISTS codigos;
CREATE TABLE codigos (
  usuario_id TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  vence TEXT NOT NULL
);

DROP TABLE IF EXISTS sesiones;
CREATE TABLE sesiones (
  token TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL,
  vence TEXT NOT NULL
);

-- qué mensaje de Telegram corresponde a qué propuesta (para responder y cambiar el texto)
CREATE TABLE IF NOT EXISTS mensajes_tg (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  propuesta_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
