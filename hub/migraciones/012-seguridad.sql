-- Agente de seguridad: los sitios propios de cada cliente que se vigilan y lo que se encontró.
CREATE TABLE IF NOT EXISTS seguridad_activos (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  url TEXT NOT NULL,                    -- https://hotel.kreatit.com.ar
  nombre TEXT,
  fallas INTEGER NOT NULL DEFAULT 0,    -- chequeos de disponibilidad seguidos que fallaron
  ultimo_chequeo TEXT,
  ms INTEGER,                           -- tiempo de respuesta del último chequeo
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, url)
);

CREATE TABLE IF NOT EXISTS seguridad_hallazgos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id TEXT NOT NULL,
  activo TEXT NOT NULL,                 -- la URL o "hub" o "repositorio"
  chequeo TEXT NOT NULL,                -- disponible, https, encabezados, certificado, archivos, email, secretos, accesos...
  nivel TEXT NOT NULL,                  -- ok | aviso | critico
  detalle TEXT,
  primera_vez TEXT NOT NULL DEFAULT (datetime('now')),
  ultima_vez TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, activo, chequeo)
);

INSERT OR IGNORE INTO seguridad_activos (id, cliente_id, url, nombre) VALUES
  ('sa-kreatit-web', 'kreatit', 'https://kreatit.com.ar', 'Web de Kreatit'),
  ('sa-kreatit-hotel', 'kreatit', 'https://hotel.kreatit.com.ar', 'GestionHotel (demo)'),
  ('sa-kreatit-hub', 'kreatit', 'https://kreatit-portero.federosciano.workers.dev/panel', 'Hub y panel');
