-- Marca los contactos que escribieron y todavía no tienen respuesta propuesta.
ALTER TABLE contactos ADD COLUMN por_responder INTEGER NOT NULL DEFAULT 0;
