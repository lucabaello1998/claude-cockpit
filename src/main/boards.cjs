'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mcp = require('./mcpClient.cjs');
const ado = require('./ado.cjs');

// Boards.
//
// Dos fuentes:
//   1. Remota: un servidor MCP que exponga un board (hoy Azure DevOps, que ya
//      tenes configurado). Es SOLO LECTURA: mover una tarjeta en la app no
//      deberia cambiar el estado real sin que lo pidas explicitamente.
//   2. Local: tableros propios guardados en la carpeta de datos de la app, con
//      jerarquia Hito > Feature > PBI > Task y columnas personalizables.

// --- jerarquia ---------------------------------------------------------------

const NIVELES = [
  { id: 'hito', label: 'Hito', color: '#a98bd4', hijo: 'feature' },
  { id: 'feature', label: 'Feature', color: '#6c9fd8', hijo: 'pbi' },
  { id: 'pbi', label: 'PBI', color: '#d97757', hijo: 'task' },
  { id: 'task', label: 'Task', color: '#7cae7a', hijo: null },
];

// Como se llaman esos mismos niveles en cada herramienta, para poder mapear.
const EQUIVALENCIAS = {
  hito: ['Epic', 'Milestone', 'Initiative'],
  feature: ['Feature'],
  pbi: ['Product Backlog Item', 'User Story', 'Story', 'Requirement', 'Issue'],
  task: ['Task', 'Bug', 'Sub-task', 'Subtask'],
};

function nivelDe(tipo) {
  const t = String(tipo || '').trim();
  for (const [nivel, nombres] of Object.entries(EQUIVALENCIAS)) {
    if (nombres.some((n) => n.toLowerCase() === t.toLowerCase())) return nivel;
  }
  return 'pbi';
}

const COLUMNAS_POR_DEFECTO = [
  { id: 'todo', titulo: 'Por hacer', wip: 0 },
  { id: 'doing', titulo: 'En curso', wip: 3 },
  { id: 'review', titulo: 'En revisión', wip: 0 },
  { id: 'done', titulo: 'Hecho', wip: 0 },
];

// --- almacenamiento local ----------------------------------------------------

function archivo(dir) { return path.join(dir, 'boards.json'); }

function leer(dir) {
  try { return JSON.parse(fs.readFileSync(archivo(dir), 'utf8')); }
  catch { return { schemaVersion: 1, boards: [] }; }
}

function escribir(dir, datos) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = archivo(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, archivo(dir));   // atomico: no deja el archivo a medias
  return datos;
}

const id = () => crypto.randomBytes(8).toString('hex');

function listarLocales(dir) {
  const d = leer(dir);
  return (d.boards || []).map((b) => ({
    id: b.id,
    nombre: b.nombre,
    columnas: b.columnas || COLUMNAS_POR_DEFECTO,
    tarjetas: (b.tarjetas || []).length,
    creado: b.creado,
  }));
}

function obtenerLocal(dir, boardId) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId) || null;
  if (!b) return null;
  // Se devuelven las mismas listas que arma el board remoto, asi la barra de
  // filtros es una sola para los dos lados.
  return {
    ...b,
    remoto: false,
    proveedor: 'local',
    sprints: sprintsLocales(b),
    responsables: responsablesLocales(b),
  };
}

// Las columnas pueden venir del renderer o de un tablero remoto importado:
// se normalizan igual que en guardarColumnas en vez de guardarlas crudas.
function normalizarColumnas(columnas) {
  const limpias = (Array.isArray(columnas) ? columnas : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      id: String(c.id || id()).slice(0, 40),
      titulo: String(c.titulo || 'Columna').slice(0, 40),
      wip: Number(c.wip) > 0 ? Number(c.wip) : 0,
    }))
    .filter((c) => c.titulo && c.id && c.id !== '__proto__' && c.id !== 'constructor');
  return limpias.length ? limpias : COLUMNAS_POR_DEFECTO.map((c) => ({ ...c }));
}

function crearBoard(dir, nombre, columnas) {
  const d = leer(dir);
  const b = {
    id: id(),
    nombre: String(nombre || 'Tablero').trim().slice(0, 80) || 'Tablero',
    columnas: normalizarColumnas(columnas),
    tarjetas: [],
    creado: new Date().toISOString(),
  };
  d.boards = d.boards || [];
  d.boards.push(b);
  escribir(dir, d);
  return b;
}

function borrarBoard(dir, boardId) {
  const d = leer(dir);
  d.boards = (d.boards || []).filter((b) => b.id !== boardId);
  escribir(dir, d);
  return { boardId };
}

function guardarColumnas(dir, boardId, columnas) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  if (!b) throw new Error('No existe ese tablero.');
  if (!Array.isArray(columnas) || !columnas.filter((c) => c && typeof c === 'object').length) {
    throw new Error('Tiene que quedar al menos una columna.');
  }
  const limpias = normalizarColumnas(columnas);
  // Las tarjetas de una columna borrada se mueven a la primera, no se pierden.
  const validas = new Set(limpias.map((c) => c.id));
  for (const t of b.tarjetas || []) if (!validas.has(t.columna)) t.columna = limpias[0].id;
  b.columnas = limpias;
  escribir(dir, d);
  return b;
}

function guardarTarjeta(dir, boardId, tarjeta) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  if (!b) throw new Error('No existe ese tablero.');
  b.tarjetas = b.tarjetas || [];

  const nivel = NIVELES.some((n) => n.id === tarjeta.nivel) ? tarjeta.nivel : 'pbi';
  const base = {
    titulo: String(tarjeta.titulo || '').trim().slice(0, 200),
    nivel,
    columna: tarjeta.columna || (b.columnas[0] && b.columnas[0].id),
    padre: tarjeta.padre || null,
    descripcion: String(tarjeta.descripcion || '').slice(0, 4000),
    estimacion: Number(tarjeta.estimacion) || 0,
    etiquetas: Array.isArray(tarjeta.etiquetas) ? tarjeta.etiquetas.slice(0, 8) : [],
    // Responsable y sprint existen tambien en los tableros propios, para que
    // los mismos filtros sirvan de los dos lados.
    asignado: String(tarjeta.asignado || '').trim().slice(0, 80) || null,
    sprint: String(tarjeta.sprint || '').trim().slice(0, 60) || null,
    actualizado: new Date().toISOString(),
  };
  if (!base.titulo) throw new Error('Falta el título.');

  // Un padre invalido (borrado, o el propio nodo) romperia el arbol.
  if (base.padre && !b.tarjetas.some((t) => t.id === base.padre)) base.padre = null;
  if (tarjeta.id && base.padre === tarjeta.id) base.padre = null;

  const existente = tarjeta.id && b.tarjetas.find((t) => t.id === tarjeta.id);
  if (existente) Object.assign(existente, base);
  else b.tarjetas.push(Object.assign({ id: id(), creado: base.actualizado }, base));

  escribir(dir, d);
  return b;
}

function moverTarjeta(dir, boardId, tarjetaId, columna) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  const t = b && (b.tarjetas || []).find((x) => x.id === tarjetaId);
  if (!t) throw new Error('No existe esa tarjeta.');
  if (!b.columnas.some((c) => c.id === columna)) throw new Error('No existe esa columna.');
  t.columna = columna;
  t.actualizado = new Date().toISOString();
  escribir(dir, d);
  return b;
}

// Los sprints de un tablero propio son texto libre: se juntan de lo que ya
// usaste, para que el desplegable se llene solo sin pedir configurarlos.
function sprintsLocales(board) {
  const v = new Map();
  for (const t of (board && board.tarjetas) || []) {
    if (!t.sprint) continue;
    v.set(t.sprint, (v.get(t.sprint) || 0) + 1);
  }
  return [...v.entries()].map(([nombre, cuantas]) => ({
    id: nombre, nombre, path: nombre, cuantas, estado: 'propio',
  })).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function responsablesLocales(board) {
  const v = new Map();
  let sin = 0;
  for (const t of (board && board.tarjetas) || []) {
    if (!t.asignado) { sin++; continue; }
    v.set(t.asignado, (v.get(t.asignado) || 0) + 1);
  }
  const out = [...v.entries()].map(([n, c]) => ({ valor: n, etiqueta: n, cuantas: c }))
    .sort((a, b) => b.cuantas - a.cuantas);
  if (sin) out.push({ valor: '__sin_asignar__', etiqueta: 'Sin asignar', cuantas: sin });
  return out;
}

// Una discusion por tarjeta, para que los tableros propios tengan lo mismo que
// los de ADO. Se guardan con la tarjeta, no en un archivo aparte.
function comentarLocal(dir, boardId, tarjetaId, texto) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('El comentario está vacío.');
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  const tar = b && (b.tarjetas || []).find((x) => x.id === tarjetaId);
  if (!tar) throw new Error('No existe esa tarjeta.');
  tar.comentarios = tar.comentarios || [];
  tar.comentarios.push({
    id: id(), texto: t.slice(0, 4000), autor: 'vos', fecha: new Date().toISOString(),
  });
  tar.actualizado = new Date().toISOString();
  escribir(dir, d);
  return tar;
}

function borrarComentarioLocal(dir, boardId, tarjetaId, comentarioId) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  const tar = b && (b.tarjetas || []).find((x) => x.id === tarjetaId);
  if (!tar) throw new Error('No existe esa tarjeta.');
  tar.comentarios = (tar.comentarios || []).filter((c) => c.id !== comentarioId);
  escribir(dir, d);
  return tar;
}

function borrarTarjeta(dir, boardId, tarjetaId) {
  const d = leer(dir);
  const b = (d.boards || []).find((x) => x.id === boardId);
  if (!b) throw new Error('No existe ese tablero.');
  b.tarjetas = (b.tarjetas || []).filter((t) => t.id !== tarjetaId);
  // Los hijos quedan huerfanos, no se borran en cascada sin avisar.
  for (const t of b.tarjetas) if (t.padre === tarjetaId) t.padre = null;
  escribir(dir, d);
  return b;
}

// --- Azure DevOps ------------------------------------------------------------
//
// La logica vive en ado.cjs desde que el board dejo de ser una lista plana:
// filtros por WIQL, sprints, detalle y escritura son bastante como para no
// mezclarlos con los tableros propios.

const adoProyectos = () => ado.proyectos();
const adoEquipos = (proyecto) => ado.equipos(proyecto);
const adoSprints = (proyecto, equipo) => ado.sprints(proyecto, equipo);
const adoEstados = (proyecto, tipo) => ado.estadosDe(proyecto, tipo);
const adoTablero = (proyecto, equipo, filtros) => ado.tablero(proyecto, equipo, filtros);
const adoDetalle = (proyecto, id) => ado.detalle(proyecto, id);
const adoCambiarEstado = (proyecto, id, estado) => ado.cambiarEstado(proyecto, id, estado);
const adoAsignar = (proyecto, id, quien) => ado.asignar(proyecto, id, quien);
const adoComentar = (proyecto, id, texto) => ado.comentar(proyecto, id, texto);

function listaDe(r, ...claves) {
  if (Array.isArray(r)) return r;
  for (const k of claves) if (r && Array.isArray(r[k])) return r[k];
  return [];
}

// --- Jira --------------------------------------------------------------------
//
// A diferencia de Azure DevOps, aca no hay un solo servidor MCP oficial: hay
// varios (el de Atlassian, mcp-atlassian de la comunidad, y otros) y cada uno
// bautiza sus herramientas distinto. En vez de adivinar un nombre, se le
// pregunta al servidor que sabe hacer (tools/list) y se elige la que sirva.
//
// Los nombres se buscan por patron, de mas especifico a mas general, para no
// agarrar por error una herramienta de escritura.

const NOMBRES_JIRA = ['jira', 'atlassian', 'mcp-atlassian'];

function servidorJira() {
  const disponibles = mcp.servidoresDisponibles();
  const s = disponibles.find((x) => NOMBRES_JIRA.includes(String(x.name).toLowerCase()))
    || disponibles.find((x) => /jira|atlassian/i.test(String(x.name)));
  if (!s) {
    throw new Error(
      'No encontré un servidor MCP de Jira. Configurá uno (por ejemplo "jira" o "atlassian") ' +
      'en Claude Code y volvé a abrir esta pestaña.'
    );
  }
  return { cliente: mcp.cliente(s.name, s.proyecto), info: s };
}

// Busca entre las herramientas del servidor la primera cuyo nombre matchee.
// Verbos que descalifican una herramienta por mas que matchee el patron:
// los ultimos patrones de la lista son substrings sueltos (/projects/i, /jql/i)
// y un `delete_projects` los cumpliria igual.
const VERBOS_DE_ESCRITURA = /(create|update|delete|remove|add|edit|set|move|assign|transition|write|post|put|patch|archive|close)/i;

function elegirHerramienta(herramientas, patrones) {
  const nombres = herramientas
    .filter((h) => h && h.name && !VERBOS_DE_ESCRITURA.test(h.name))
    .map((h) => h.name);
  for (const re of patrones) {
    const hit = nombres.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

// Los campos de una issue de Jira viajan anidados y con nombres que cambian
// entre la API v2 y la v3. Se prueban los lugares habituales.
function campoJira(issue, ...rutas) {
  for (const ruta of rutas) {
    let v = issue;
    for (const k of ruta.split('.')) {
      if (v == null) break;
      v = v[k];
    }
    if (v != null && v !== '') return v;
  }
  return null;
}

async function jiraProyectos() {
  const { cliente: c } = servidorJira();
  const herramientas = await c.tools();
  const tool = elegirHerramienta(herramientas, [
    /^jira_get_all_projects$/i, /get.*all.*projects/i, /jira.*projects/i, /projects/i,
  ]);
  if (!tool) {
    throw new Error(
      'Ese servidor MCP no expone ninguna herramienta para listar proyectos de Jira. ' +
      'Tiene: ' + herramientas.map((h) => h.name).slice(0, 8).join(', ')
    );
  }
  const r = await c.call(tool, {});
  const lista = listaDe(r, 'values', 'projects', 'value', 'results');
  return lista.map((x) => ({
    id: String(campoJira(x, 'key', 'id') || ''),
    name: campoJira(x, 'name', 'key') || '(sin nombre)',
    description: campoJira(x, 'description') || '',
  })).filter((x) => x.id);
}

// Trae las issues de un proyecto y las normaliza a la misma forma que el
// tablero de Azure DevOps, para que la UI no tenga que saber de donde salieron.
// Un campo puede venir como objeto o como string segun el servidor: solo se
// acepta algo que sirva como texto.
function texto(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

async function jiraTablero(proyectoKey) {
  const { cliente: c, info } = servidorJira();
  let aviso = null;
  let issues = [];

  const herramientas = await c.tools();
  const tool = elegirHerramienta(herramientas, [
    /^jira_search$/i, /jira.*search/i, /search.*issues?/i, /^searchJira/i, /jql/i,
  ]);
  if (!tool) {
    throw new Error(
      'El servidor "' + info.name + '" no expone una herramienta de búsqueda de issues. ' +
      'Tiene: ' + herramientas.map((h) => h.name).slice(0, 8).join(', ')
    );
  }

  // Cada servidor nombra el parametro distinto: se mandan los tres alias
  // habituales, los que sobran se ignoran.
  const jql = `project = "${String(proyectoKey).replace(/"/g, '')}" ORDER BY created DESC`;
  // Jira pagina de a lotes: sin esto, un proyecto de mas de 200 issues mostraba
  // un tablero incompleto sin decirlo.
  const LOTE = 100;
  const MAXIMO = 1000;
  try {
    for (let desde = 0; desde < MAXIMO; desde += LOTE) {
      const r = await c.call(tool, {
        jql, query: jql, searchString: jql,
        limit: LOTE, maxResults: LOTE,
        startAt: desde, start_at: desde, offset: desde,
      });
      const lote = listaDe(r, 'issues', 'values', 'results', 'value');
      if (!lote.length) break;
      issues = issues.concat(lote);
      // Si el servidor ignora el parametro de offset devuelve siempre lo mismo:
      // se corta al primer lote para no duplicar hasta el infinito.
      if (desde > 0 && lote[0] && issues[0]
        && String(campoJira(lote[0], 'key', 'id')) === String(campoJira(issues[0], 'key', 'id'))) {
        issues = issues.slice(0, LOTE);
        aviso = 'Ese servidor no soporta paginado: se muestran las primeras ' + LOTE + ' issues.';
        break;
      }
      if (lote.length < LOTE) break;
      if (desde + LOTE >= MAXIMO) {
        aviso = 'El proyecto tiene más de ' + MAXIMO + ' issues: se muestran las primeras.';
      }
    }
  } catch (e) {
    throw new Error('No pude consultar Jira: ' + String(e.message || e).slice(0, 200));
  }
  if (!issues.length) aviso = 'La consulta funcionó pero el proyecto no devolvió issues.';

  const tarjetas = [];
  const columnas = new Map();
  for (const it of issues) {
    // Algunos servidores aplanan la issue y dejan `fields.status` como string
    // en vez de objeto: hay que probar tambien las rutas escalares.
    const estado = texto(campoJira(it, 'fields.status.name', 'status.name', 'fields.status', 'status')) || 'Sin estado';
    const tipo = texto(campoJira(it, 'fields.issuetype.name', 'issuetype.name', 'fields.issuetype', 'type')) || '';
    const titulo = texto(campoJira(it, 'fields.summary', 'summary', 'title')) || '(sin título)';
    const padre = campoJira(it, 'fields.parent.key', 'parent.key', 'fields.parent.id', 'fields.parent');
    const asignado = texto(campoJira(it,
      'fields.assignee.displayName', 'assignee.displayName', 'assignee.name', 'fields.assignee'));
    const puntos = Number(campoJira(it, 'fields.customfield_10016', 'fields.storyPoints', 'storyPoints') || 0);
    const etiquetas = campoJira(it, 'fields.labels', 'labels');
    if (!columnas.has(estado)) columnas.set(estado, { id: estado, titulo: estado, wip: 0 });
    tarjetas.push({
      id: String(campoJira(it, 'key', 'id') || tarjetas.length),
      titulo,
      nivel: nivelDe(tipo),
      tipoOriginal: tipo,
      columna: estado,
      padre: padre ? String(padre) : null,
      asignado: asignado || null,
      estimacion: Number.isFinite(puntos) ? puntos : 0,
      etiquetas: Array.isArray(etiquetas) ? etiquetas : [],
      url: campoJira(it, 'self', 'url'),
    });
  }

  return {
    remoto: true,
    proveedor: 'jira',
    nombre: String(proyectoKey),
    columnas: [...columnas.values()],
    tarjetas,
    aviso,
  };
}

// Convierte un tablero remoto en uno local editable, para poder trabajarlo sin
// tocar el sistema de origen.
function importarComoLocal(dir, remoto, nombre) {
  if (!remoto || !Array.isArray(remoto.tarjetas)) throw new Error('Ese tablero no se puede importar.');
  const b = crearBoard(dir, nombre || remoto.nombre, remoto.columnas);
  const d = leer(dir);
  const destino = d.boards.find((x) => x.id === b.id);
  const mapa = new Map();
  for (const t of remoto.tarjetas) {
    const nuevo = {
      id: id(), titulo: t.titulo, nivel: t.nivel, columna: t.columna,
      padre: null, descripcion: t.asignado ? 'Asignado a ' + t.asignado : '',
      estimacion: t.estimacion || 0, etiquetas: t.etiquetas || [],
      origen: { proveedor: remoto.proveedor, id: t.id, url: t.url },
      creado: new Date().toISOString(), actualizado: new Date().toISOString(),
    };
    mapa.set(String(t.id), nuevo.id);
    destino.tarjetas.push(nuevo);
  }
  // Recien con todos creados se pueden enlazar los padres.
  for (const t of remoto.tarjetas) {
    if (!t.padre) continue;
    const hijo = destino.tarjetas.find((x) => x.origen && String(x.origen.id) === String(t.id));
    const padre = mapa.get(String(t.padre));
    if (hijo && padre) hijo.padre = padre;
  }
  escribir(dir, d);
  return destino;
}

function proveedores() {
  const servidores = mcp.servidoresDisponibles();
  return [
    { id: 'local', nombre: 'Tableros propios', disponible: true },
    (() => {
      const j = servidores.find((s) => NOMBRES_JIRA.includes(String(s.name).toLowerCase()))
        || servidores.find((s) => /jira|atlassian/i.test(String(s.name)));
      return {
        id: 'jira', nombre: 'Jira',
        disponible: !!j,
        via: j ? `MCP "${j.name}"` : 'necesita un MCP de Jira o Atlassian',
        origen: j ? (j.proyecto ? 'definido por ' + j.proyecto : 'alcance de usuario') : null,
      };
    })(),
    (() => {
      const ado = servidores.find((s) => s.name === 'ado');
      return {
        id: 'azure-devops', nombre: 'Azure DevOps',
        disponible: !!ado,
        via: 'MCP "ado"',
        // De donde sale la definicion: si la pone un proyecto conviene que se
        // vea, porque abrir el tablero levanta ese proceso.
        origen: ado ? (ado.proyecto ? 'definido por ' + ado.proyecto : 'alcance de usuario') : null,
      };
    })(),
  ];
}

module.exports = {
  NIVELES, COLUMNAS_POR_DEFECTO, EQUIVALENCIAS,
  proveedores, listarLocales, obtenerLocal, crearBoard, borrarBoard,
  guardarColumnas, guardarTarjeta, moverTarjeta, borrarTarjeta,
  adoProyectos, adoEquipos, adoSprints, adoEstados, adoTablero, adoDetalle,
  adoCambiarEstado, adoAsignar, adoComentar,
  jiraProyectos, jiraTablero,
  sprintsLocales, responsablesLocales, comentarLocal, borrarComentarioLocal,
  importarComoLocal,
};
