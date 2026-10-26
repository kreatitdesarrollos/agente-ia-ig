-- Fase 3: leads (contactos) y conversaciones por mensaje directo de Instagram y formularios web.

CREATE TABLE IF NOT EXISTS contactos (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  canal TEXT NOT NULL,                  -- instagram | web
  externo_id TEXT,                      -- id de la persona en Instagram (IGSID)
  usuario TEXT,                         -- @ de Instagram
  nombre TEXT,
  telefono TEXT,
  email TEXT,
  etapa TEXT NOT NULL DEFAULT 'nuevo',  -- nuevo | conversando | interesado | cliente | perdido
  interes TEXT,                         -- alto | medio | bajo
  resumen TEXT,                         -- qué busca, en una línea (lo completa la IA)
  notas TEXT,
  ultimo_mensaje TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, canal, externo_id)
);
CREATE INDEX IF NOT EXISTS contactos_cliente ON contactos (cliente_id, ultimo_mensaje);

CREATE TABLE IF NOT EXISTS mensajes (
  id TEXT PRIMARY KEY,                  -- id del mensaje en Instagram (o generado)
  cliente_id TEXT NOT NULL,
  contacto_id TEXT NOT NULL,
  direccion TEXT NOT NULL,              -- entrante | saliente
  texto TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS mensajes_contacto ON mensajes (contacto_id, fecha);

ALTER TABLE clientes ADD COLUMN auto_mensajes INTEGER NOT NULL DEFAULT 0;
