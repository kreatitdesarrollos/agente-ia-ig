-- Reseñas de Google Play: cada cliente carga sus apps y su cuenta de servicio de Google (cifrada).
ALTER TABLE clientes ADD COLUMN play_apps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE clientes ADD COLUMN play_cuenta TEXT;
ALTER TABLE clientes ADD COLUMN play_sincronizado TEXT;

CREATE TABLE IF NOT EXISTS resenas (
  id TEXT PRIMARY KEY,                  -- reviewId de Google Play
  cliente_id TEXT NOT NULL,
  app TEXT NOT NULL,                    -- nombre del paquete (ej. ar.com.kreatit)
  autor TEXT,
  estrellas INTEGER,
  texto TEXT,
  version TEXT,
  fecha TEXT,
  respuesta TEXT,                       -- la respuesta publicada (si hay)
  categoria TEXT,
  estado TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | propuesto | respondido | ignorado
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS resenas_estado ON resenas (estado, cliente_id);

UPDATE clientes SET play_apps = '["ar.com.kreatit"]' WHERE id = 'kreatit';
