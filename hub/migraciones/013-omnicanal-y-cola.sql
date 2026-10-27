-- Vendedor omnicanal (Messenger, WhatsApp, chat web) y cola de publicación del Publicador.
ALTER TABLE clientes ADD COLUMN fb_pagina_id TEXT;          -- página de Facebook (Messenger y publicaciones)
ALTER TABLE clientes ADD COLUMN fb_token TEXT;              -- cifrado: token de la página
ALTER TABLE clientes ADD COLUMN wa_phone_id TEXT;           -- WhatsApp Cloud API: id del número
ALTER TABLE clientes ADD COLUMN wa_numero TEXT;             -- el número, para mostrar
ALTER TABLE clientes ADD COLUMN wa_token TEXT;              -- cifrado
ALTER TABLE clientes ADD COLUMN chat_config TEXT NOT NULL DEFAULT '{"activo":false,"saludo":"¡Hola! ¿En qué te puedo ayudar?","color":"#4b3fb0"}';
ALTER TABLE clientes ADD COLUMN publicacion_config TEXT NOT NULL DEFAULT '{"por_dia":2,"horarios":["12:00","19:00"],"facebook":false}';
ALTER TABLE propuestas ADD COLUMN programada TEXT;          -- cuándo sale (cola de publicación)
