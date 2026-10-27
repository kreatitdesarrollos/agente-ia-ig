-- Prospección en frío (B2B): campañas, prospectos, bajas y la casilla de envío de cada cliente (cifrada).
ALTER TABLE clientes ADD COLUMN prospeccion_correo TEXT;   -- JSON cifrado: smtp/imap, usuario, clave, remitente, firma

CREATE TABLE IF NOT EXISTS prospecciones (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rubro TEXT,                          -- ej. "hoteles"
  zona TEXT,                           -- ej. "Córdoba, Argentina"
  oferta TEXT,                         -- qué se ofrece y por qué le sirve
  link TEXT,                           -- ej. https://hotel.kreatit.com.ar
  por_dia INTEGER NOT NULL DEFAULT 15,
  seguimientos TEXT NOT NULL DEFAULT '[3,7]',
  activa INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prospectos (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  prospeccion_id TEXT NOT NULL,
  nombre TEXT,
  email TEXT NOT NULL,
  web TEXT,
  telefono TEXT,
  ciudad TEXT,
  fuente TEXT,                         -- osm | csv
  resumen TEXT,                        -- lo que la IA entendió de su web
  estado TEXT NOT NULL DEFAULT 'nuevo',-- nuevo | propuesto | aprobado | enviado | respondio | baja | rebote | descartado | terminado
  paso INTEGER NOT NULL DEFAULT 0,     -- 0 = primer email; 1, 2 = seguimientos
  asunto TEXT,
  message_id TEXT,                     -- del primer email (para los seguimientos en el mismo hilo)
  proximo TEXT,                        -- cuándo toca el próximo seguimiento
  ultimo_envio TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, email)
);
CREATE INDEX IF NOT EXISTS prospectos_estado ON prospectos (cliente_id, estado, proximo);

CREATE TABLE IF NOT EXISTS bajas_frio (
  cliente_id TEXT NOT NULL,
  email TEXT NOT NULL,
  motivo TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cliente_id, email)
);

CREATE TABLE IF NOT EXISTS envios_frio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id TEXT NOT NULL,
  prospecto_id TEXT NOT NULL,
  paso INTEGER NOT NULL,
  asunto TEXT,
  cuerpo TEXT,
  message_id TEXT,
  estado TEXT NOT NULL DEFAULT 'enviado',
  detalle TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);
