'use strict';
const https = require('https');
const mcp = require('./mcpClient.cjs');

// Azure DevOps a traves del servidor MCP "ado".
//
// Se separo de boards.cjs cuando el board dejo de ser una lista plana de solo
// lectura y paso a tener filtros, detalle y escritura.
//
// Dos cosas de este MCP que no son obvias y hay que respetar:
//
//   1. Casi todo se pide con un parametro `action`, no con un nombre de
//      herramienta distinto por operacion.
//   2. Varias respuestas NO son JSON pelado: vienen como texto con adornos
//      adelante ("Project: X, Team: Y\n[...]") o envueltas en un marcador
//      contra inyeccion de prompts. Por eso existe desenvolver().
//
// Sobre ese marcador: el MCP avisa que el contenido de los work items es
// texto que escribio otra persona. Aca se trata SIEMPRE como dato: se muestra
// en la UI como texto plano, nunca se interpreta ni se ejecuta, y el HTML de
// descripciones y comentarios se convierte a texto antes de salir del main.

const IDENTIDAD = '@Me';   // macro de WIQL: el usuario del PAT configurado

function cliente() {
  const s = mcp.ubicar('ado');
  if (!s) {
    throw new Error('No hay un servidor MCP llamado "ado" configurado. Agregalo desde Configuración → MCP.');
  }
  return mcp.cliente('ado', s.proyecto);
}

function conexion() {
  const s = mcp.ubicar('ado');
  if (!s) return { conectado: false, motivo: 'No hay un servidor MCP llamado "ado".' };
  // La organizacion viaja como argumento suelto en la definicion del servidor:
  // el primer argumento que no es una opcion ni el paquete.
  const def = mcp.definicionDe('ado', s.proyecto) || {};
  const args = def.args || [];
  const org = args.find((a, i) => i > 0 && !String(a).startsWith('-') && !String(a).includes('/')) || null;
  return {
    conectado: true,
    organizacion: org,
    url: org ? 'https://dev.azure.com/' + org : null,
    definidoPor: s.proyecto || 'tu configuración de usuario',
    alcance: s.alcance,
  };
}

// --- columnas reales del board -----------------------------------------------
//
// El MCP no expone la configuracion del board del equipo, y sin ella las
// columnas salian de agrupar por System.State: nombres crudos ("New",
// "In Progress"), sin las vacias, sin orden y sin limites WIP. En ADO el board
// de Features de este equipo es Nuevo / En Curso(10) / Testing(5) / Pre Pro(5)
// / Finalizado, que es otra cosa.
//
// Eso solo esta en la API REST de Azure DevOps, asi que se la consulta directo
// con el MISMO token que ya usa el servidor MCP, guardado en su definicion.
// Sale unicamente a dev.azure.com (el host esta fijo, no viene de ninguna
// entrada) y no se escribe en ningun log.
//
// Si algo de esto falla se vuelve a agrupar por estado: es peor no mostrar el
// tablero que mostrarlo con las columnas viejas.

const HOST_ADO = 'dev.azure.com';

function credencial() {
  const s = mcp.ubicar('ado');
  if (!s) return null;
  const def = mcp.definicionDe('ado', s.proyecto) || {};
  const v = (def.env || {}).PERSONAL_ACCESS_TOKEN;
  if (!v) return null;
  // El valor ya viene en base64 de "usuario:token", que es lo que espera
  // la autenticacion Basic; re-codificarlo daba 302 al login.
  return String(v);
}

function restGet(ruta) {
  const cred = credencial();
  if (!cred) return Promise.reject(new Error('El servidor MCP "ado" no tiene un token configurado.'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST_ADO, path: ruta, method: 'GET',
      headers: { Authorization: 'Basic ' + cred, Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 302 es el login: el token vencio o no tiene permiso.
          return reject(new Error('Azure DevOps respondió ' + res.statusCode +
            (res.statusCode === 302 ? ' (el token no sirve para esto)' : '')));
        }
        try { resolve(JSON.parse(b)); } catch { reject(new Error('Respuesta no válida.')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Azure DevOps tardó demasiado.')); });
    req.on('error', (e) => reject(new Error('No se pudo llegar a Azure DevOps: ' + e.message)));
    req.end();
  });
}

const ruta = (...partes) => '/' + partes.map((x) => encodeURIComponent(x)).join('/');

// Un equipo tiene un board por nivel del backlog (Epics, Features, Backlog
// items...). Cual corresponde no se adivina por el nombre, que cambia con el
// idioma y el proceso: se mira `stateMappings`, cuyas claves son los tipos de
// work item de ese board.
const cacheColumnas = new Map();

async function columnasDelBoard(proyecto, equipo, nivel) {
  if (!proyecto || !equipo || !nivel) return null;
  const clave = [proyecto, equipo, nivel].join('|');
  if (cacheColumnas.has(clave)) return cacheColumnas.get(clave);

  const org = (conexion() || {}).organizacion;
  if (!org) return null;
  const base = ruta(org, proyecto, equipo) + '/_apis/work/boards';

  let elegido = null;
  const lista = (await restGet(base + '?api-version=7.1')).value || [];
  for (const b of lista) {
    const cols = (await restGet(base + ruta(b.id) + '/columns?api-version=7.1')).value || [];
    const tipos = new Set();
    for (const c of cols) for (const t of Object.keys(c.stateMappings || {})) tipos.add(t);
    // El board sirve si sus tipos caen en el nivel que se esta mirando.
    if ([...tipos].some((t) => nivelDe(t) === nivel)) {
      elegido = {
        board: b.name,
        columnas: cols.map((c, i) => ({
          id: c.name,
          titulo: c.name,
          wip: Number(c.itemLimit) || 0,
          tipo: c.columnType || null,
          orden: i,
        })),
      };
      break;
    }
  }
  cacheColumnas.set(clave, elegido);
  return elegido;
}

// --- desenvolver respuestas --------------------------------------------------

function desenvolver(r) {
  if (r == null) return null;
  if (typeof r === 'object' && !r.text) return r;
  let txt = typeof r === 'string' ? r : String(r.text || '');
  // El marcador tiene corchetes propios: hay que sacarlo ANTES de buscar
  // donde arranca el JSON, o se parsea desde el corchete equivocado.
  txt = txt.replace(/<<[0-9a-f]{8,}>>[\s\S]*?<<[0-9a-f]{8,}>>/g, '');
  const i = txt.search(/[[{]/);
  if (i < 0) return null;
  const recorte = txt.slice(i);
  try { return JSON.parse(recorte); } catch { /* puede haber basura al final */ }
  // Se busca el cierre balanceado, ignorando llaves dentro de strings.
  const abre = recorte[0];
  const cierra = abre === '[' ? ']' : '}';
  let nivel = 0; let dentro = false; let esc = false;
  for (let k = 0; k < recorte.length; k++) {
    const ch = recorte[k];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { dentro = !dentro; continue; }
    if (dentro) continue;
    if (ch === abre) nivel++;
    else if (ch === cierra) {
      nivel--;
      if (!nivel) { try { return JSON.parse(recorte.slice(0, k + 1)); } catch { return null; } }
    }
  }
  return null;
}

function lista(r, ...claves) {
  const d = desenvolver(r);
  if (Array.isArray(d)) return d;
  for (const k of claves) if (d && Array.isArray(d[k])) return d[k];
  return [];
}

// --- WIQL --------------------------------------------------------------------

// En WIQL la comilla simple se escapa duplicandola. Los valores salen de
// desplegables armados con datos reales, pero igual se escapan: el dia que
// alguien escriba un filtro a mano esto ya esta.
function q(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

function enLista(campo, valores) {
  const v = (valores || []).filter(Boolean);
  if (!v.length) return null;
  return `[${campo}] IN (${v.map((x) => `'${q(x)}'`).join(', ')})`;
}

// Arma la consulta a partir de los filtros de la UI.
// Los botones de la UI eligen NIVELES de la jerarquia interna (hito, feature,
// pbi, task), pero WIQL filtra por el tipo de work item de ADO, que se llama
// distinto en cada proceso. Sin esta traduccion los botones no hacian nada en
// el board remoto: apretabas PBIs y seguian viniendo Tasks.
//
// Probado: WIQL ignora sin quejarse los tipos que no existen en el proyecto,
// asi que se pueden mandar todos los nombres conocidos de cada nivel.
const TIPOS_POR_NIVEL = {
  hito: ['Epic', 'Milestone', 'Initiative'],
  feature: ['Feature'],
  pbi: ['Product Backlog Item', 'User Story', 'Story', 'Requirement', 'Issue'],
  task: ['Task', 'Bug', 'Sub-task', 'Subtask', 'Impediment'],
};

function tiposDeNiveles(niveles) {
  const out = [];
  for (const n of niveles || []) for (const t of TIPOS_POR_NIVEL[n] || []) out.push(t);
  return out;
}

function construirWiql(proyecto, f) {
  const filtros = f || {};
  const donde = [`[System.TeamProject] = '${q(proyecto)}'`];

  // `tipos` permite pedir tipos exactos; `niveles` es lo que manda la UI.
  const tiposPedidos = (filtros.tipos && filtros.tipos.length)
    ? filtros.tipos
    : tiposDeNiveles(filtros.niveles);
  const tipos = enLista('System.WorkItemType', tiposPedidos);
  if (tipos) donde.push(tipos);

  const estados = enLista('System.State', filtros.estados);
  if (estados) donde.push(estados);

  if (filtros.soloMias) {
    donde.push(`[System.AssignedTo] = ${IDENTIDAD}`);
  } else if (filtros.responsable) {
    if (filtros.responsable === '__sin_asignar__') donde.push('[System.AssignedTo] = \'\'');
    else donde.push(`[System.AssignedTo] = '${q(filtros.responsable)}'`);
  }

  // El sprint se filtra por su ruta (Proyecto\Sprint 3), que es lo que guarda
  // el work item. UNDER incluye los hijos de esa iteracion.
  if (filtros.sprint) donde.push(`[System.IterationPath] UNDER '${q(filtros.sprint)}'`);

  if (filtros.texto) donde.push(`[System.Title] CONTAINS '${q(filtros.texto)}'`);

  if (!filtros.incluirCerradas) {
    donde.push("[System.State] NOT IN ('Removed', 'Closed')");
  }

  return 'SELECT [System.Id] FROM WorkItems WHERE ' + donde.join(' AND ') +
    ' ORDER BY [System.ChangedDate] DESC';
}

// --- lectura -----------------------------------------------------------------

async function proyectos() {
  const c = cliente();
  return lista(await c.call('core_list_projects', {}), 'value')
    .map((p) => ({ id: p.id, name: p.name, description: p.description || '' }));
}

async function equipos(proyecto) {
  const c = cliente();
  return lista(await c.call('core_list_project_teams', { project: proyecto }), 'value')
    .map((t) => ({ id: t.id, name: t.name }));
}

async function sprints(proyecto, equipo) {
  const c = cliente();
  if (!equipo) return [];
  const it = lista(await c.call('work', { action: 'list_team_iterations', project: proyecto, team: equipo }), 'value');
  return it.map((x) => {
    const a = x.attributes || {};
    return {
      id: x.id,
      nombre: x.name,
      path: x.path,
      desde: a.startDate || null,
      hasta: a.finishDate || null,
      // 0 = pasado, 1 = en curso, 2 = futuro
      estado: a.timeFrame === 1 ? 'actual' : (a.timeFrame === 0 ? 'pasado' : 'futuro'),
    };
  });
}

// Los estados posibles salen del tipo de work item, con el color que usa ADO.
const cacheEstados = new Map();
async function estadosDe(proyecto, tipo) {
  const clave = proyecto + '|' + tipo;
  if (cacheEstados.has(clave)) return cacheEstados.get(clave);
  const c = cliente();
  const d = desenvolver(await c.call('wit_work_item', {
    action: 'get_type', project: proyecto, workItemType: tipo,
  }));
  const st = ((d && d.states) || []).map((s) => ({
    nombre: s.name, color: s.color ? '#' + s.color : null, categoria: s.category || null,
  }));
  cacheEstados.set(clave, st);
  return st;
}

const CAMPOS = [
  'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
  'System.AssignedTo', 'System.IterationPath', 'System.Parent', 'System.Tags',
  // El nombre de la columna del board del equipo, que no es lo mismo que el
  // estado: "In Progress" puede caer en "En Curso", "Testing" o "Pre Pro".
  'System.BoardColumn', 'System.BoardColumnDone',
  'System.ChangedDate', 'System.CreatedDate',
  'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort',
  'Microsoft.VSTS.Common.Priority',
];

// Trae los work items que cumplen los filtros. Son dos pasos obligados: WIQL
// devuelve solo ids, y el detalle se pide en lote.
async function tablero(proyecto, equipo, filtros) {
  const c = cliente();
  let aviso = null;
  let ids = [];

  // Tope de la consulta. Un backlog real pasa largo de esto y un kanban con
  // miles de tarjetas no se puede usar igual; lo importante es DECIRLO, porque
  // ver 500 y creer que es todo es peor que ver 500 sabiendo que hay mas.
  const TOPE = 500;
  const wiql = construirWiql(proyecto, filtros);
  try {
    const r = desenvolver(await c.call('wit_query', {
      action: 'wiql', project: proyecto, wiql, top: TOPE,
    }));
    ids = ((r && r.workItems) || []).map((w) => w.id).filter((n) => Number.isFinite(Number(n)));
  } catch (e) {
    throw new Error('No pude consultar Azure DevOps: ' + String(e.message || e).slice(0, 200));
  }
  const recortado = ids.length >= TOPE;

  const items = [];
  // get_batch tiene tope de 200.
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const r = await c.call('wit_work_item', {
      action: 'get_batch', project: proyecto, ids: lote, fields: CAMPOS,
    });
    for (const w of lista(r, 'value', 'workItems')) items.push(w);
  }
  if (ids.length && !items.length) aviso = 'La consulta devolvió ids pero no se pudo traer el detalle.';
  if (recortado) {
    aviso = `Hay más de ${TOPE} work items: se muestran los ${TOPE} modificados más recientemente. ` +
      'Filtrá por sprint, responsable o nivel para ver el resto.';
  }

  const tarjetas = items.map((w) => normalizar(w));

  // Las columnas de verdad solo existen para UN nivel a la vez: en ADO el
  // board siempre muestra un nivel del backlog. Con varios niveles elegidos (o
  // ninguno) no hay un juego de columnas unico y se cae a los estados.
  const niveles = (filtros && filtros.niveles) || [];
  let columnas = null;
  let board = null;
  if (niveles.length === 1) {
    try {
      const cfg = await columnasDelBoard(proyecto, equipo, niveles[0]);
      if (cfg && cfg.columnas.length) { columnas = cfg.columnas; board = cfg.board; }
    } catch (e) {
      // No es motivo para no mostrar el tablero.
      aviso = aviso || ('No pude leer las columnas del board: ' + String(e.message || e).slice(0, 120));
    }
  }

  if (!columnas) {
    columnas = [];
    const vistas = new Set();
    for (const t of tarjetas) {
      if (vistas.has(t.columna)) continue;
      vistas.add(t.columna);
      columnas.push({ id: t.columna, titulo: t.columna, wip: 0 });
    }
  } else {
    // Una tarjeta cuya columna no esta en la configuracion (quedo de una
    // columna borrada) igual tiene que verse: se le agrega su columna al final.
    const conocidas = new Set(columnas.map((c) => c.id));
    for (const t of tarjetas) {
      if (t.columna && !conocidas.has(t.columna)) {
        conocidas.add(t.columna);
        columnas.push({ id: t.columna, titulo: t.columna, wip: 0, fueraDelBoard: true });
      }
    }
  }
  if (!tarjetas.length) {
    aviso = aviso || 'Ningún work item cumple esos filtros.';
  }

  return {
    remoto: true,
    proveedor: 'azure-devops',
    proyecto,
    equipo: equipo || null,
    nombre: `${proyecto}${equipo ? ' · ' + equipo : ''}`,
    columnas,
    board,
    tarjetas,
    responsables: responsablesDe(tarjetas),
    recortado,
    aviso,
    consulta: wiql,
  };
}

const NIVEL_POR_TIPO = {
  epic: 'hito', milestone: 'hito', initiative: 'hito',
  feature: 'feature',
  'product backlog item': 'pbi', 'user story': 'pbi', story: 'pbi', requirement: 'pbi', issue: 'pbi',
  task: 'task', bug: 'task', 'sub-task': 'task', subtask: 'task', impediment: 'task',
};

function nivelDe(tipo) {
  return NIVEL_POR_TIPO[String(tipo || '').toLowerCase()] || 'pbi';
}

// El campo AssignedTo llega con DOS formas distintas segun por donde se pida
// el work item, y esto costo un bug real:
//
//   get_batch (el del tablero) -> "Ana Perez <ana.perez@empresa.com>"
//   get       (el del detalle) -> { displayName: "Ana Perez", uniqueName: ... }
//
// Comparando el texto crudo, el <select> del detalle no encontraba su opcion y
// el navegador caia en la primera: todo aparecia como "Sin asignar".
//
// La identidad estable es el email. Probado contra WIQL: filtrar por email,
// por nombre solo o por "nombre <email>" devuelve exactamente lo mismo, asi
// que el email sirve de clave unica para comparar, filtrar y asignar.
function persona(v) {
  if (!v) return null;
  const crudo = typeof v === 'string' ? v : (v.displayName || v.uniqueName || '');
  if (!crudo) return null;
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(crudo);
  const email = (typeof v === 'object' && v.uniqueName) || (m ? m[2] : null);
  const nombre = m ? m[1].trim() : crudo;
  return {
    nombre,
    crudo,
    email,
    // Con lo que se compara en todos lados. Si no hay email (una identidad
    // vieja o un grupo), el nombre alcanza.
    clave: email || nombre,
    avatar: (typeof v === 'object' && v._links && v._links.avatar && v._links.avatar.href) || null,
  };
}

function normalizar(w) {
  const f = w.fields || {};
  const tipo = f['System.WorkItemType'] || '';
  const asignado = persona(f['System.AssignedTo']);
  const iter = f['System.IterationPath'] || '';
  return {
    id: String(w.id),
    titulo: f['System.Title'] || '(sin título)',
    nivel: nivelDe(tipo),
    tipoOriginal: tipo,
    // La columna del board manda; el estado es el respaldo.
    columna: f['System.BoardColumn'] || f['System.State'] || 'Sin estado',
    estado: f['System.State'] || null,
    columnaBoard: f['System.BoardColumn'] || null,
    padre: f['System.Parent'] != null ? String(f['System.Parent']) : null,
    asignado: asignado ? asignado.nombre : null,
    // La clave con la que se compara y se filtra (el email, en general).
    asignadoClave: asignado ? asignado.clave : null,
    asignadoEmail: asignado ? asignado.email : null,
    sprint: iter.includes('\\') ? iter.split('\\').pop() : (iter || null),
    sprintPath: iter || null,
    estimacion: Number(f['Microsoft.VSTS.Scheduling.StoryPoints'] || f['Microsoft.VSTS.Scheduling.Effort'] || 0),
    prioridad: f['Microsoft.VSTS.Common.Priority'] != null ? Number(f['Microsoft.VSTS.Common.Priority']) : null,
    etiquetas: String(f['System.Tags'] || '').split(';').map((s) => s.trim()).filter(Boolean),
    modificado: f['System.ChangedDate'] || null,
    creado: f['System.CreatedDate'] || null,
    url: (w._links && w._links.html && w._links.html.href) || null,
  };
}

// La lista de responsables sale de lo que efectivamente hay en el tablero: asi
// el desplegable siempre coincide con lo que se ve y no hace falta otra
// llamada para traer los miembros del equipo.
function responsablesDe(tarjetas) {
  const m = new Map();
  let sinAsignar = 0;
  for (const t of tarjetas) {
    if (!t.asignadoClave) { sinAsignar++; continue; }
    const e = m.get(t.asignadoClave) || { valor: t.asignadoClave, etiqueta: t.asignado, cuantas: 0 };
    e.cuantas++;
    m.set(t.asignadoClave, e);
  }
  const out = [...m.values()].sort((a, b) => b.cuantas - a.cuantas);
  if (sinAsignar) out.push({ valor: '__sin_asignar__', etiqueta: 'Sin asignar', cuantas: sinAsignar });
  return out;
}

// --- detalle -----------------------------------------------------------------

// Las descripciones y los comentarios de ADO son HTML escrito por otras
// personas. No se manda HTML al renderer: se convierte a texto plano. Es lo
// unico seguro sin meter un sanitizador entero, y para leer alcanza.
function aTexto(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<img[^>]*>/gi, '[imagen]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CAMPOS_INTERESANTES = [
  ['System.Description', 'Descripción'],
  ['Microsoft.VSTS.Common.AcceptanceCriteria', 'Criterios de aceptación'],
  ['Microsoft.VSTS.TCM.ReproSteps', 'Pasos para reproducir'],
  ['Microsoft.VSTS.Common.ResolvedReason', 'Motivo de resolución'],
];

async function detalle(proyecto, id) {
  const c = cliente();
  const d = desenvolver(await c.call('wit_work_item', {
    action: 'get', project: proyecto, id: Number(id), expand: 'All',
  }));
  if (!d) throw new Error('No se pudo leer el work item #' + id + '.');
  const f = d.fields || {};

  const textos = [];
  for (const [campo, titulo] of CAMPOS_INTERESANTES) {
    const t = aTexto(f[campo]);
    if (t) textos.push({ titulo, texto: t });
  }

  // Los campos que no estan en la lista fija igual pueden importar (campos
  // propios del proceso del equipo). Se mandan los que tengan valor simple.
  const otros = [];
  for (const [k, v] of Object.entries(f)) {
    if (CAMPOS.includes(k) || CAMPOS_INTERESANTES.some(([c2]) => c2 === k)) continue;
    if (v == null || typeof v === 'object') continue;
    if (typeof v === 'string' && /<[a-z][\s\S]*>/i.test(v)) continue;   // HTML: ya se cubrio arriba
    otros.push({ campo: k.replace(/^.*\./, ''), valor: String(v).slice(0, 200) });
  }

  let comentarios = [];
  try {
    const cm = desenvolver(await c.call('wit_work_item', {
      action: 'list_comments', project: proyecto, workItemId: Number(id),
    }));
    comentarios = ((cm && cm.comments) || []).map((x) => ({
      id: x.id,
      texto: aTexto(x.text),
      autor: (persona(x.createdBy) || {}).nombre || null,
      fecha: x.createdDate || null,
    })).filter((x) => x.texto);
  } catch { /* el work item puede no tener comentarios habilitados */ }

  const base = normalizar(d);
  const relaciones = (d.relations || [])
    .filter((r) => r && r.rel && /Hierarchy|Related/.test(r.rel))
    .map((r) => ({
      tipo: /Forward/.test(r.rel) ? 'hijo' : (/Reverse/.test(r.rel) ? 'padre' : 'relacionado'),
      id: String(r.url || '').split('/').pop(),
      nombre: (r.attributes && r.attributes.name) || null,
    }))
    .filter((r) => /^\d+$/.test(r.id));

  return { ...base, textos, otros, comentarios, relaciones, rev: d.rev };
}

// --- escritura ---------------------------------------------------------------
//
// Toda escritura toca el board real del equipo. Cada funcion hace UNA cosa y
// devuelve el work item actualizado, para que la UI muestre lo que quedo
// guardado y no lo que creia haber mandado.

async function actualizar(proyecto, id, updates) {
  const c = cliente();
  const r = await c.call('wit_work_item_write', {
    action: 'update', project: proyecto, id: Number(id), updates,
  });
  const d = desenvolver(r);
  if (!d) throw new Error('Azure DevOps no confirmó el cambio.');
  return normalizar(d);
}

function cambiarEstado(proyecto, id, estado) {
  if (!String(estado || '').trim()) throw new Error('Falta el estado.');
  return actualizar(proyecto, id, [{ op: 'add', path: '/fields/System.State', value: String(estado) }]);
}

// `quien` es el email (uniqueName). Vacio desasigna.
function asignar(proyecto, id, quien) {
  const v = String(quien == null ? '' : quien).trim();
  return actualizar(proyecto, id, [{ op: 'add', path: '/fields/System.AssignedTo', value: v }]);
}

async function comentar(proyecto, id, texto) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('El comentario está vacío.');
  const c = cliente();
  await c.call('wit_work_item_comment_write', {
    action: 'add', project: proyecto, workItemId: Number(id), text: t, format: 'Markdown',
  });
  return detalle(proyecto, id);
}

module.exports = {
  conexion, proyectos, equipos, sprints, estadosDe, tablero, detalle,
  columnasDelBoard,
  cambiarEstado, asignar, comentar,
  // exportados para poder probarlos sin pegarle a la red
  desenvolver, construirWiql, aTexto, nivelDe, normalizar, responsablesDe,
  tiposDeNiveles, TIPOS_POR_NIVEL,
};
