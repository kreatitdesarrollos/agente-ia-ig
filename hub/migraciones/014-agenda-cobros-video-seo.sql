-- Agenda (Google Calendar), cobros (Mercado Pago), redactor SEO (WordPress) y configuración de video.
ALTER TABLE clientes ADD COLUMN agenda_config TEXT NOT NULL DEFAULT '{"activo":false,"calendario_id":"","duracion":30,"dias":[1,2,3,4,5],"desde":"09:00","hasta":"18:00"}';
ALTER TABLE clientes ADD COLUMN agenda_cuenta TEXT;      -- cifrado: cuenta de servicio de Google con acceso al calendario
ALTER TABLE clientes ADD COLUMN mp_token TEXT;           -- cifrado: access token de Mercado Pago
ALTER TABLE clientes ADD COLUMN seo_config TEXT NOT NULL DEFAULT '{"activo":false,"temas":[],"por_mes":4}';
ALTER TABLE clientes ADD COLUMN wp_config TEXT;          -- cifrado: {url, usuario, clave} de WordPress (contraseña de aplicación)
ALTER TABLE clientes ADD COLUMN video_config TEXT NOT NULL DEFAULT '{"por_semana":2,"voz":false}';
ALTER TABLE clientes ADD COLUMN ultimo_seo TEXT;
ALTER TABLE clientes ADD COLUMN ultimo_video TEXT;

CREATE TABLE IF NOT EXISTS cobros (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  contacto_id TEXT,
  concepto TEXT NOT NULL,
  monto REAL NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | pagado | cancelado
  link TEXT,
  preferencia_id TEXT,
  pago_id TEXT,
  avisado INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  pagado_en TEXT
);
CREATE INDEX IF NOT EXISTS cobros_cliente ON cobros (cliente_id, estado);
