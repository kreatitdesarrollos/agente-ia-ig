-- Investigador de mercado: qué temas y competidores sigue cada cliente, y los informes con sus ideas.
ALTER TABLE clientes ADD COLUMN investigacion TEXT NOT NULL DEFAULT '{}';
ALTER TABLE clientes ADD COLUMN ultimo_mercado TEXT;
ALTER TABLE informes ADD COLUMN datos TEXT;

UPDATE clientes SET investigacion = '{"temas":["trenes argentinos","app trenes Argentina","juegos para celular argentinos","agentes de IA WhatsApp para negocios","sistemas de gestión para sindicatos y mutuales"],"competidores":[]}' WHERE id = 'kreatit';
