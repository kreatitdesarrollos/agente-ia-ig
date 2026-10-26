-- Nutrición de leads por email (Brevo): secuencia por cliente, emails propuestos/enviados y bajas.
ALTER TABLE clientes ADD COLUMN nutricion TEXT NOT NULL DEFAULT '{}';
ALTER TABLE contactos ADD COLUMN nutricion_paso INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contactos ADD COLUMN nutricion_proximo TEXT;
ALTER TABLE contactos ADD COLUMN baja INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  contacto_id TEXT NOT NULL,
  paso INTEGER NOT NULL,
  asunto TEXT,
  cuerpo TEXT,
  estado TEXT NOT NULL DEFAULT 'enviado',   -- enviado | error
  detalle TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS emails_contacto ON emails (contacto_id, fecha);

UPDATE clientes SET nutricion = '{"activo":false,"auto":false,"remitente_nombre":"Kreatit","remitente_email":"hola@kreatit.com.ar","responder_a":"","pasos":[{"dias":0,"objetivo":"Bienvenida: agradecer el contacto, responder lo que preguntó y contar en qué lo podemos ayudar"},{"dias":2,"objetivo":"Valor: un consejo útil o un ejemplo concreto relacionado con lo que busca"},{"dias":5,"objetivo":"Caso o demostración: cómo resolvimos algo parecido para otro cliente (sin inventar datos)"},{"dias":10,"objetivo":"Invitación: proponer una charla o demo sin cargo, con un llamado a la acción claro"}]}' WHERE id = 'kreatit';
