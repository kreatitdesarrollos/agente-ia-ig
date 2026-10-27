// "La oficina": el estado de cada agente de IA de un cliente, armado con lo que el hub ya registra
// (eventos, propuestas pendientes, errores y tareas programadas). Lo dibuja el panel.

import { horaLocal } from "./comun.js";

// Cada agente: qué tipos de propuesta aprueba, qué eventos son suyos y qué palabras tienen sus errores.
const AGENTES = [
  { id: "redactor", nombre: "Redactor y diseñador", tarea: "Escribe y diseña los posts", propuestas: ["post"],
    eventos: ["generando", "propuesta", "aprobada", "publicada"], errores: /generar|publicar|imagen|post/i },
  { id: "community", nombre: "Community manager", tarea: "Responde los comentarios", propuestas: ["respuesta"],
    eventos: ["comentario", "respondido", "oculto"], errores: /comentario/i },
  { id: "vendedor", nombre: "Vendedor", tarea: "Atiende mensajes y leads", propuestas: ["mensaje"],
    eventos: ["mensaje", "enviado", "lead"], errores: /mensaje directo|mensajes directos/i },
  { id: "atencion", nombre: "Atención al cliente", tarea: "Responde las reseñas de la app", propuestas: ["resena"],
    eventos: ["resena"], errores: /reseña|google play/i },
  { id: "emails", nombre: "Email marketer", tarea: "Hace el seguimiento por email", propuestas: ["email"],
    eventos: ["email", "baja"], errores: /email/i },
  { id: "analista", nombre: "Analista", tarea: "Mide los posts y arma el informe", propuestas: [],
    eventos: ["token"], errores: /sincronizar|métricas|resultados/i },
  { id: "investigador", nombre: "Investigador de mercado", tarea: "Sigue noticias y competencia", propuestas: [],
    eventos: ["investigando", "investigacion"], errores: /investiga/i },
  { id: "trafficker", nombre: "Trafficker", tarea: "Arma y mide los anuncios", propuestas: ["anuncio"],
    eventos: ["anuncio"], errores: /campaña|anuncio/i },
  { id: "prospector", nombre: "Prospector", tarea: "Busca negocios y les escribe propuestas", propuestas: ["prospecto"],
    eventos: ["prospeccion"], errores: /prospector|prospección/i },
  { id: "seguridad", nombre: "Seguridad", tarea: "Vigila la seguridad de los sistemas", propuestas: [],
    eventos: ["seguridad"], errores: /^$/ },
];

const EN_CURSO = { generando: "propuesta", investigando: "investigacion" }; // evento de inicio → evento que lo termina

export async function estadoOficina(env, clienteId) {
  const c = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(clienteId).first();
  if (!c) return null;
  const eventos = (await env.DB.prepare(
    "SELECT tipo, detalle, creado FROM eventos WHERE cliente_id = ? AND creado > datetime('now', '-30 days') ORDER BY id DESC LIMIT 400"
  ).bind(clienteId).all()).results;
  const pendientes = (await env.DB.prepare(
    "SELECT tipo, COUNT(*) AS n FROM propuestas WHERE cliente_id = ? AND estado = 'pendiente' GROUP BY tipo"
  ).bind(clienteId).all()).results;
  const contar = async (sql) => (await env.DB.prepare(sql).bind(clienteId).first())?.n ?? 0;
  const ahora = Date.now();
  const hace = (fecha) => (ahora - new Date(fecha.replace(" ", "T") + "Z").getTime()) / 60000; // minutos

  const datos = {
    redactor: { dato: `${await contar("SELECT COUNT(*) n FROM propuestas WHERE cliente_id = ? AND tipo = 'post' AND estado = 'publicada'")} posts publicados`,
      proxima: `Post diario: todos los días a las ${c.hora_post}` },
    community: { dato: `${await contar("SELECT COUNT(*) n FROM comentarios WHERE cliente_id = ? AND estado IN ('respondido', 'oculto')")} comentarios atendidos`,
      proxima: c.ig_token ? "Revisa comentarios nuevos cada 15 minutos" : "Esperando que conectes Instagram" },
    vendedor: { dato: `${await contar("SELECT COUNT(*) n FROM contactos WHERE cliente_id = ?")} leads · ${await contar("SELECT COUNT(*) n FROM contactos WHERE cliente_id = ? AND etapa = 'cliente'")} clientes`,
      proxima: c.ig_token ? "Responde al instante cuando alguien escribe" : "Esperando que conectes Instagram" },
    atencion: { dato: `${await contar("SELECT COUNT(*) n FROM resenas WHERE cliente_id = ? AND estado = 'respondido'")} reseñas respondidas`,
      proxima: c.play_cuenta ? "Revisa Google Play cada 30 minutos" : "Esperando que conectes Google Play" },
    emails: { dato: `${await contar("SELECT COUNT(*) n FROM emails WHERE cliente_id = ? AND estado = 'enviado'")} emails enviados`,
      proxima: JSON.parse(c.nutricion || "{}").activo ? "Revisa la secuencia cada 5 minutos" : "Apagado (se activa en Mi cuenta → Nutrición)" },
    analista: { dato: `${await contar("SELECT COUNT(*) n FROM publicaciones_ig WHERE cliente_id = ? AND metricas_actualizadas IS NOT NULL")} posts medidos`,
      proxima: c.ig_token ? `Informe semanal: lunes 9:30 · midió por última vez ${c.ig_sincronizado ? "hace " + Math.round(hace(c.ig_sincronizado)) + " min" : "nunca"}` : "Esperando que conectes Instagram" },
    investigador: { dato: `${await contar("SELECT COUNT(*) n FROM informes WHERE cliente_id = ? AND tipo = 'mercado'")} investigaciones`,
      proxima: JSON.parse(c.investigacion || "{}").temas?.length ? "Investigación semanal: miércoles 9:30" : "Cargá temas en Investigación para que arranque" },
    prospector: { dato: `${await contar("SELECT COUNT(*) n FROM envios_frio WHERE cliente_id = ? AND estado = 'enviado'")} propuestas enviadas · ${await contar("SELECT COUNT(*) n FROM prospectos WHERE cliente_id = ? AND estado = 'respondio'")} respondieron`,
      proxima: c.prospeccion_correo ? "Envíos a las 10 y a las 16 (días hábiles)" : "Esperando que configures la casilla de prospección" },
    seguridad: { dato: `${await contar("SELECT COUNT(*) n FROM seguridad_activos WHERE cliente_id = ?")} sitios vigilados · ${await contar("SELECT COUNT(*) n FROM seguridad_hallazgos WHERE cliente_id = ? AND nivel = 'aviso'")} avisos`,
      proxima: "Revisa los sitios cada 15 minutos y hace un chequeo profundo cada mañana" },
    trafficker: { dato: `${await contar("SELECT COUNT(*) n FROM campanas WHERE cliente_id = ? AND estado = 'ACTIVE'")} campañas activas`,
      proxima: c.ads_token ? "Mide las campañas cada 3 horas" : "Esperando que conectes la cuenta publicitaria" },
  };

  // seguridad: crítico abierto = problema; si revisó hace poco = trabajando (vigila todo el tiempo)
  const criticos = (await env.DB.prepare("SELECT activo, chequeo FROM seguridad_hallazgos WHERE cliente_id = ? AND nivel = 'critico'").bind(clienteId).all()).results;
  const revisado = await env.DB.prepare("SELECT MAX(ultimo_chequeo) AS t FROM seguridad_activos WHERE cliente_id = ?").bind(clienteId).first();
  const estadoSeguridad = criticos.length
    ? { estado: "error", globo: `Hay ${criticos.length} problema${criticos.length > 1 ? "s" : ""} crítico${criticos.length > 1 ? "s" : ""}: ${criticos.map((x) => x.chequeo + " en " + x.activo).join(", ")}`.slice(0, 140) }
    : revisado?.t && hace(revisado.t) < 20 ? { estado: "trabajando", globo: "Vigilando los sitios: todo en orden" } : { estado: "descanso", globo: "" };

  const agentes = AGENTES.map((a) => {
    const propios = eventos.filter((e) => a.eventos.includes(e.tipo));
    const errores = eventos.filter((e) => e.tipo === "error" && a.errores.test(e.detalle || ""));
    const ultimo = propios[0];
    const error = errores[0] && hace(errores[0].creado) < 24 * 60 && (!ultimo || errores[0].creado >= ultimo.creado) ? errores[0] : null;
    const enCurso = ultimo && EN_CURSO[ultimo.tipo] && hace(ultimo.creado) < 15 ? ultimo : null;
    const reciente = ultimo && hace(ultimo.creado) < 3 ? ultimo : null;
    const pend = pendientes.filter((p) => a.propuestas.includes(p.tipo)).reduce((t, p) => t + p.n, 0);
    let estado = "descanso";
    let globo = "";
    if (a.id === "seguridad") return { ...a, errores: undefined, eventos: undefined, ...estadoSeguridad, pendientes: 0, ...datos[a.id],
      historial: propios.slice(0, 8) };
    if (error) { estado = "error"; globo = "Tuve un problema: " + error.detalle; }
    else if (enCurso) { estado = "trabajando"; globo = (ultimo.tipo === "investigando" ? "Investigando: " : "Escribiendo: ") + (ultimo.detalle || "…"); }
    else if (pend) { estado = "esperando"; globo = `Tengo ${pend} para que apruebes`; }
    else if (reciente) { estado = "trabajando"; globo = reciente.detalle || ""; }
    return {
      ...a, errores: undefined, eventos: undefined, estado, globo: globo.slice(0, 140), pendientes: pend,
      ...datos[a.id], historial: [...propios, ...errores].sort((x, y) => (x.creado < y.creado ? 1 : -1)).slice(0, 8),
    };
  });
  return { cliente: { id: c.id, nombre: c.nombre }, hora: horaLocal(c.zona).hora, agentes };
}
