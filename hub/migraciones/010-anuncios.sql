-- Anuncios de Meta: cuenta publicitaria por cliente (token cifrado), campañas creadas por el hub y públicos.
ALTER TABLE clientes ADD COLUMN ads_cuenta TEXT;        -- act_123...
ALTER TABLE clientes ADD COLUMN ads_pagina TEXT;        -- id de la página de Facebook
ALTER TABLE clientes ADD COLUMN ads_token TEXT;         -- cifrado (token de usuario del sistema)
ALTER TABLE clientes ADD COLUMN ads_tope_diario INTEGER NOT NULL DEFAULT 0;  -- en la moneda de la cuenta
ALTER TABLE clientes ADD COLUMN ads_moneda TEXT;
ALTER TABLE clientes ADD COLUMN ads_link TEXT;          -- destino por defecto (web, tienda de apps...)
ALTER TABLE clientes ADD COLUMN ads_sincronizado TEXT;

CREATE TABLE IF NOT EXISTS campanas (
  id TEXT PRIMARY KEY,                 -- id de la campaña en Meta
  cliente_id TEXT NOT NULL,
  propuesta_id TEXT,
  nombre TEXT,
  objetivo TEXT,
  estado TEXT,                         -- el estado efectivo en Meta (PAUSED, ACTIVE, ...)
  presupuesto_diario INTEGER,
  dias INTEGER,
  fin TEXT,
  conjunto_id TEXT,
  anuncio_id TEXT,
  gasto REAL,
  impresiones INTEGER,
  alcance INTEGER,
  clics INTEGER,
  resultados TEXT,
  metricas_actualizadas TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audiencias (
  id TEXT PRIMARY KEY,                 -- id del público en Meta
  cliente_id TEXT NOT NULL,
  tipo TEXT NOT NULL,                  -- interactuaron | leads
  nombre TEXT,
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE clientes SET ads_link = 'https://play.google.com/store/apps/details?id=ar.com.kreatit' WHERE id = 'kreatit';
