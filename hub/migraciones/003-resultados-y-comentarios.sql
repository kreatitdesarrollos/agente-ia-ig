-- Fase 2: estudio de contenido (métricas de cada post) y reputación (comentarios de Instagram).

-- Cada post de Instagram del cliente (publicado por el hub o a mano) con sus números.
CREATE TABLE IF NOT EXISTS publicaciones_ig (
  media_id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  propuesta_id TEXT,
  texto TEXT,
  fecha TEXT,
  enlace TEXT,
  me_gusta INTEGER NOT NULL DEFAULT 0,
  comentarios INTEGER NOT NULL DEFAULT 0,
  alcance INTEGER,
  guardados INTEGER,
  compartidos INTEGER,
  interacciones INTEGER,
  comentarios_vistos INTEGER NOT NULL DEFAULT 0,
  metricas_actualizadas TEXT
);
CREATE INDEX IF NOT EXISTS publicaciones_cliente ON publicaciones_ig (cliente_id, fecha);

CREATE TABLE IF NOT EXISTS comentarios (
  id TEXT PRIMARY KEY,                 -- id del comentario en Instagram
  cliente_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  usuario TEXT,
  texto TEXT,
  fecha TEXT,
  categoria TEXT,                      -- pregunta | elogio | queja | compra | spam | otro
  estado TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | propuesto | respondido | oculto | ignorado
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS comentarios_estado ON comentarios (estado, cliente_id);

CREATE TABLE IF NOT EXISTS informes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'semanal',
  texto TEXT NOT NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE clientes ADD COLUMN ig_usuario TEXT;
ALTER TABLE clientes ADD COLUMN ig_sincronizado TEXT;
ALTER TABLE clientes ADD COLUMN ultimo_informe TEXT;
