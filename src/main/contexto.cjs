'use strict';
const fs = require('fs');
const path = require('path');
const { P, statSafe } = require('./sources/paths.cjs');
const memoria = require('./sources/memory.cjs');
const transcripts = require('./sources/transcripts.cjs');
const seguro = require('./safePaths.cjs');

// Que sabe Claude Code cuando arranca una sesion nueva.
//
// El problema que resuelve: cuando una sesion se compacta, cuando abris una
// nueva, o cuando te vas a otra maquina, se pierde todo lo que aprendiste. Y
// eso duele mas cuanto mas larga fue la sesion.
//
// Lo importante es que Claude Code YA tiene el mecanismo y lo lee solo:
//
//   ~/.claude/projects/<proyecto>/memory/*.md   con MEMORY.md de indice
//   <repo>/CLAUDE.md                            instrucciones del proyecto
//
// Asi que aca no se inventa nada nuevo: se hace visible lo que ya existe, se
// deja editar, y se ayuda a llenarlo. Inventar un formato propio significaria
// que Claude Code no lo lee, que es justo lo que no sirve.

// --- que cargaria una sesion nueva -------------------------------------------

// readAll() solo devuelve proyectos que YA tienen memorias, asi que escondia
// justo los que hay que atender: los vacios. Se enumeran todos los proyectos
// con transcripts y se cruzan con lo que haya.
function todosLosProyectos() {
  const out = new Map();
  try {
    for (const d of fs.readdirSync(P.projects, { withFileTypes: true })) {
      if (d.isDirectory()) out.set(d.name, null);
    }
  } catch { /* sin proyectos */ }
  return out;
}

async function porProyecto() {
  const m = await memoria.readAll();
  const salida = [];
  const pendientes = todosLosProyectos();

  for (const p of m.claudeMemory || []) {
    pendientes.delete(p.projectDir);
    const claudeMd = p.projectPath ? path.join(p.projectPath, 'CLAUDE.md') : null;
    const stMd = claudeMd ? statSafe(claudeMd) : null;
    salida.push({
      projectDir: p.projectDir,
      projectPath: p.projectPath || null,
      nombre: p.projectPath ? path.basename(p.projectPath) : p.projectDir,
      dir: p.dir,
      // Lo que Claude Code inyecta en cada sesion de ese proyecto.
      memorias: (p.entries || []).map((e) => ({
        file: e.file, name: e.name, description: e.description,
        type: e.type, bytes: e.sizeBytes, mtimeMs: e.mtimeMs,
      })),
      indice: !!p.index,
      claudeMd: stMd ? { path: claudeMd, bytes: stMd.size, mtimeMs: stMd.mtimeMs } : null,
      // Un proyecto sin nada es justamente el que va a perder contexto.
      vacio: !(p.entries || []).length && !stMd,
    });
  }
  // Los que no tenian ni la carpeta creada.
  for (const projectDir of pendientes.keys()) {
    const ruta = rutaDeProyecto(projectDir);
    const md = ruta ? path.join(ruta, 'CLAUDE.md') : null;
    const st = md ? statSafe(md) : null;
    salida.push({
      projectDir,
      projectPath: ruta,
      nombre: ruta ? path.basename(ruta) : projectDir,
      dir: path.join(P.projects, projectDir, 'memory'),
      memorias: [],
      indice: false,
      claudeMd: st ? { path: md, bytes: st.size, mtimeMs: st.mtimeMs } : null,
      vacio: !st,
    });
  }

  // Primero lo que esta vacio: es lo que va a perder contexto.
  return salida.sort((a, b) => {
    if (a.vacio !== b.vacio) return a.vacio ? -1 : 1;
    return b.memorias.length - a.memorias.length;
  });
}

// El nombre de la carpeta es la ruta con los separadores reemplazados. No se
// puede revertir sin ambiguedad, asi que se busca contra los proyectos reales.
function rutaDeProyecto(projectDir) {
  const cj = require('./sources/paths.cjs').readJSON(P.CLAUDE_JSON, {}) || {};
  for (const ruta of Object.keys(cj.projects || {})) {
    const codificado = ruta.replace(/[\/:]/g, '-');
    if (codificado === projectDir || codificado.toLowerCase() === projectDir.toLowerCase()) return ruta;
  }
  return null;
}

// --- leer y escribir ---------------------------------------------------------

function dirDe(projectDir) {
  const seg = seguro.segmentoSeguro(projectDir);
  if (!seg) throw new Error('Proyecto inválido.');
  const d = path.join(P.projects, seg, 'memory');
  if (!seguro.dentroDe(P.projects, d)) throw new Error('Proyecto inválido.');
  return d;
}

function leerMemoria(projectDir, file) {
  const dir = dirDe(projectDir);
  const f = seguro.unirSeguro(dir, file);
  if (!f) throw new Error('Nombre de archivo inválido.');
  try { return fs.readFileSync(f, 'utf8'); }
  catch { throw new Error('No pude leer ' + file + '.'); }
}

// El formato es el que ya usa Claude Code: frontmatter con name, description y
// metadata.type, y el cuerpo abajo. Si se cambia, deja de leerlo.
function armarMemoria({ name, description, type, body }) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!n) throw new Error('Falta el nombre.');
  const d = String(description || '').trim().replace(/"/g, "'");
  if (!d) throw new Error('Falta la descripción: es lo que se usa para decidir si esta memoria es relevante.');
  const t = ['user', 'feedback', 'project', 'reference'].includes(type) ? type : 'project';
  return {
    nombre: n,
    texto: '---\n'
      + 'name: ' + n + '\n'
      + 'description: "' + d + '"\n'
      + 'metadata:\n'
      + '  node_type: memory\n'
      + '  type: ' + t + '\n'
      + '  modified: ' + new Date().toISOString() + '\n'
      + '---\n\n'
      + String(body || '').trim() + '\n',
  };
}

function guardarMemoria(projectDir, datos) {
  const dir = dirDe(projectDir);
  const { nombre, texto } = armarMemoria(datos);
  const archivo = (datos.file && seguro.segmentoSeguro(datos.file)) || (nombre + '.md');
  const destino = seguro.unirSeguro(dir, archivo);
  if (!destino) throw new Error('Nombre de archivo inválido.');
  fs.mkdirSync(dir, { recursive: true });
  if (!seguro.destinoRealSeguro(dir, destino)) {
    throw new Error('Ese destino sale de la carpeta de memoria (¿es un enlace simbólico?).');
  }
  fs.writeFileSync(destino, texto);
  actualizarIndice(dir);
  return { file: archivo, path: destino };
}

function borrarMemoria(projectDir, file) {
  const dir = dirDe(projectDir);
  const f = seguro.unirSeguro(dir, file);
  if (!f || !statSafe(f)) throw new Error('Esa memoria ya no existe.');
  fs.unlinkSync(f);
  actualizarIndice(dir);
  return { ok: true };
}

// MEMORY.md es el indice que Claude Code carga en cada sesion: una linea por
// memoria. Si queda desactualizado, las memorias existen pero no se encuentran.
function actualizarIndice(dir) {
  const lineas = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const meta = {};
    if (fm) {
      for (const l of fm[1].split(/\r?\n/)) {
        const kv = /^([\w-]+):\s*(.*)$/.exec(l);
        if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    const titulo = (meta.name || f.replace(/\.md$/, '')).replace(/-/g, ' ');
    const desc = meta.description || '';
    lineas.push('- [' + titulo.charAt(0).toUpperCase() + titulo.slice(1) + '](' + f + ')'
      + (desc ? ' — ' + desc : ''));
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), lineas.join('\n') + (lineas.length ? '\n' : ''));
  return lineas.length;
}

// --- candidatos a memoria de una conversacion --------------------------------

// Lo que se puede sacar de un transcript SIN un modelo: tus propios mensajes.
//
// Aviso honesto sobre esto: se probo contra una sesion real de 1007 mensajes y
// lo que encuentra son sobre todo PEDIDOS ("estaria bueno que...", "no seria
// mejor..."), no decisiones durables. Matchea palabras, no importancia, y eso
// no se arregla con mas expresiones regulares.
//
// Sirve como materia prima ordenada, no como "esto hay que guardar". Para la
// extraccion de verdad esta prepararPrompt(), que le pasa la conversacion a
// Claude Code — que si tiene modelo y ya sabe escribir memorias.
const SENIALES = [
  { re: /\b(no|nunca|jamas|jamás)\b.{0,40}\b(hagas|uses|pongas|toques|vuelvas)\b/i, peso: 3, por: 'te dice qué NO hacer' },
  { re: /\b(acord[aá]te|record[aá]|ten[ée] en cuenta|ojo con|cuidado con)\b/i, peso: 3, por: 'pediste que se recuerde' },
  { re: /\b(en realidad|mejor|prefiero|prefer[ií]|en vez de|no es as[ií])\b/i, peso: 2, por: 'corrección' },
  { re: /\b(siempre|de ahora en m[aá]s|a partir de ahora|de aqu[ií] en adelante)\b/i, peso: 3, por: 'regla permanente' },
  { re: /\b(porque|porqué|el motivo|la razón|la razon)\b/i, peso: 1, por: 'explica un porqué' },
  { re: /\b(decid[ií]|decidimos|vamos con|queda as[ií]|dale con)\b/i, peso: 2, por: 'decisión tomada' },
];

async function candidatos(file) {
  if (!file || !statSafe(file)) throw new Error('No encuentro ese transcript.');
  const hilo = await transcripts.loadThread(file, { limit: 100000, includeSidechain: false });
  const mensajes = Array.isArray(hilo) ? hilo : (hilo.messages || []);

  const out = [];
  for (const m of mensajes) {
    // Un mensaje tuyo de verdad: rol usuario, no una devolucion de herramienta
    // ni algo que inyecto el harness (una skill, un recordatorio del sistema).
    if (m.role !== 'user') continue;
    if (m.isToolReturn || m.injected || m.isConversation === false) continue;
    const texto = (m.blocks || [])
      .filter((b) => b && b.type === 'text' && b.text)
      .map((b) => b.text).join('\n').trim();
    if (!texto || texto.length < 25) continue;
    // Los mensajes muy largos suelen ser pegados de logs, no decisiones.
    if (texto.length > 1200) continue;

    let peso = 0;
    const porQue = [];
    for (const s of SENIALES) {
      if (s.re.test(texto)) { peso += s.peso; porQue.push(s.por); }
    }
    if (!peso) continue;
    out.push({
      i: m.i,
      ts: m.ts || null,
      texto: texto.slice(0, 700),
      peso,
      porQue: [...new Set(porQue)],
    });
  }

  // Un mensaje repetido (lo mandaste dos veces, o reintentaste tras una
  // interrupcion) aparecia dos veces en la lista.
  const vistos = new Set();
  return out
    .sort((a, b) => b.peso - a.peso)
    .filter((c) => {
      const clave = c.texto.slice(0, 120).replace(/\s+/g, ' ').toLowerCase();
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    })
    .slice(0, 25);
}

// El camino bueno: preparar el pedido para que lo corras en Claude Code, que
// tiene el modelo y ya sabe escribir memorias en el formato correcto. Cockpit
// no adivina que es importante; le da el material y el destino exacto.
function prepararPrompt(sesion, projectDir) {
  const dir = projectDir ? path.join(P.projects, projectDir, 'memory') : '<carpeta memory del proyecto>';
  return [
    'Leé el transcript de esta sesión:',
    '',
    '    ' + (sesion.file || '<ruta del .jsonl>'),
    '',
    'y guardá como memorias lo que valga la pena que una sesión futura sepa.',
    '',
    'Buscá sobre todo:',
    '- decisiones que tomamos y **por qué** (el porqué es lo que se pierde)',
    '- correcciones mías sobre cómo trabajar',
    '- trampas del proyecto que costó descubrir',
    '- cosas que quedaron pendientes',
    '',
    'No guardes lo que ya está en el código o en el historial de git.',
    '',
    'Escribilas en:',
    '',
    '    ' + dir,
    '',
    'una por archivo, con el frontmatter de siempre (name, description,',
    'metadata.type) y agregá la línea correspondiente a MEMORY.md.',
  ].join('\n');
}

// --- entregarle el contexto a Claude Code ------------------------------------

// Cockpit no puede chatear: no tiene modelo. Lo que si puede es preparar el
// contexto para que se lo lleves a Claude Code, que es donde ya pagas.
function paqueteContexto(sesion, elegidos) {
  const l = [];
  l.push('# Contexto de una sesión anterior');
  l.push('');
  if (sesion.title) l.push('**Sesión:** ' + sesion.title);
  if (sesion.project) l.push('**Proyecto:** ' + sesion.project);
  if (sesion.startedAt) l.push('**Cuándo:** ' + String(sesion.startedAt).slice(0, 16).replace('T', ' '));
  if (sesion.totals) {
    l.push('**Tamaño:** ' + sesion.totals.requests + ' requests · '
      + Math.round(sesion.totals.totalTokens / 1000) + 'k tokens');
  }
  l.push('');
  l.push('Esto es lo que quedó de esa sesión. No hace falta que la releas: acá');
  l.push('está lo que decidí y lo que pedí que se tenga en cuenta.');
  l.push('');
  l.push('## Lo que dije');
  l.push('');
  for (const c of elegidos || []) {
    l.push('- ' + String(c.texto).replace(/\n+/g, ' ').trim());
  }
  if (!(elegidos || []).length) l.push('_(no se eligió nada)_');
  l.push('');
  l.push('---');
  l.push('_Preparado por Claude Cockpit desde el transcript._');
  return l.join('\n');
}

// --- catalogo para traer contexto a cualquier sesion -------------------------
//
// Lo que se puede "traer" no es todo igual, y confundirlo seria caro:
//
//   - Las memorias son .md de unos KB: se traen ENTERAS.
//   - Un grafo de codigo tiene decenas de miles de nodos. Meterlo en contexto
//     es absurdo; lo que se trae es el PUNTERO: que existe, de que commit es, y
//     con que herramientas se consulta. Son ~50 tokens en vez de megabytes.
//
// El catalogo lo mantiene Cockpit y lo lee la skill `cockpit-memory`, que se
// instala en ~/.claude/skills. Asi cualquier sesion de Claude Code puede pedir
// contexto sin que Cockpit tenga que estar abierto.

const NOMBRE_SKILL = 'cockpit-memory';

async function catalogo() {
  const proyectos = await porProyecto();
  const m = await memoria.readAll();

  const memorias = [];
  for (const p of proyectos) {
    for (const e of p.memorias) {
      memorias.push({
        id: p.projectDir + '/' + e.file,
        proyecto: p.nombre,
        projectDir: p.projectDir,
        archivo: path.join(p.dir, e.file),
        nombre: e.name,
        descripcion: e.description,
        tipo: e.type || 'project',
        bytes: e.bytes,
      });
    }
    if (p.claudeMd) {
      memorias.push({
        id: p.projectDir + '/CLAUDE.md',
        proyecto: p.nombre,
        projectDir: p.projectDir,
        archivo: p.claudeMd.path,
        nombre: 'CLAUDE.md',
        descripcion: 'Instrucciones del proyecto ' + p.nombre,
        tipo: 'reference',
        bytes: p.claudeMd.bytes,
      });
    }
  }

  // Los grafos NO se traen: se anuncian.
  const grafos = [];
  for (const prov of m.providers || []) {
    for (const st of prov.stores || []) {
      grafos.push({
        id: prov.id + '/' + st.name,
        proveedor: prov.id,
        etiqueta: prov.label,
        repo: st.root || st.dir || null,
        nombre: st.name,
        nodos: st.nodes || null,
        aristas: st.edges || null,
        indexadoEn: st.indexedAt || null,
        commitIndexado: st.indexedCommit || null,
        desactualizado: !!st.stale,
        // Con que se consulta. Sin esto el puntero no sirve de nada.
        herramientas: prov.id === 'codebase-memory'
          ? ['mcp__codebase-memory-mcp__search_graph', 'mcp__codebase-memory-mcp__trace_path',
            'mcp__codebase-memory-mcp__get_architecture', 'mcp__codebase-memory-mcp__get_code_snippet']
          : [],
      });
    }
  }

  return {
    generadoEn: new Date().toISOString(),
    memorias: memorias.sort((a, b) => a.proyecto.localeCompare(b.proyecto)),
    grafos,
  };
}

// La skill es fina a proposito: solo sabe leer el catalogo. Toda la logica de
// que hay disponible vive en Cockpit, que es quien mira el disco.
function textoSkill(rutaCatalogo) {
  return [
    '---',
    'name: ' + NOMBRE_SKILL,
    'description: Traer a esta sesion contexto guardado de otros proyectos o sesiones anteriores: memorias de Claude Code, CLAUDE.md de otros repos, y los grafos de codigo indexados. Usar cuando el usuario pida traer contexto, recordar lo de otro proyecto, seguir algo de otra sesion, o escriba /cockpit-memory.',
    '---',
    '',
    '# Traer contexto guardado',
    '',
    'El catalogo lo mantiene Claude Cockpit y esta en:',
    '',
    '    ' + rutaCatalogo,
    '',
    '## Que hacer',
    '',
    '1. Lee ese JSON. Tiene dos listas: `memorias` y `grafos`.',
    '',
    '2. Mostrale al usuario lo que hay, agrupado por proyecto, en una tabla corta:',
    '   nombre, proyecto y descripcion. No vuelques el JSON crudo.',
    '',
    '3. Preguntale cual quiere traer. Si te lo dijo en el pedido ("trae lo de',
    '   FletAR"), filtra vos y no preguntes de gusto.',
    '',
    '4. Segun que eligio:',
    '',
    '   - **Memorias**: leelas con Read desde el campo `archivo` y resumilas en',
    '     esta conversacion. Son archivos chicos.',
    '',
    '   - **Grafos**: NO intentes leerlos. Tienen decenas de miles de nodos y no',
    '     entran en contexto. Lo unico que hay que hacer es avisar que existen y',
    '     usar las herramientas de `herramientas` cuando haga falta consultarlos.',
    '     Si `desactualizado` es true, decilo: el indice es de un commit viejo.',
    '',
    '## Lo que no hay que hacer',
    '',
    '- No copies una memoria a este proyecto sin que te lo pidan. Traerla a la',
    '  conversacion no es lo mismo que duplicarla en disco.',
    '- Si el catalogo no existe o esta viejo, decilo en vez de inventar: se',
    '  regenera abriendo Claude Cockpit.',
    '',
  ].join('\n');
}

function rutaSkill() {
  return path.join(P.skills, NOMBRE_SKILL);
}

// Escribe (o actualiza) la skill y su catalogo. Es idempotente: se puede
// llamar en cada refresh sin ensuciar nada.
async function instalarSkill() {
  const dir = rutaSkill();
  if (!seguro.dentroDe(P.skills, dir)) throw new Error('Ruta de skill inválida.');
  fs.mkdirSync(dir, { recursive: true });
  const cat = path.join(dir, 'catalogo.json');
  fs.writeFileSync(cat, JSON.stringify(await catalogo(), null, 2));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), textoSkill(cat));
  return { dir, catalogo: cat };
}

function skillInstalada() {
  return !!statSafe(path.join(rutaSkill(), 'SKILL.md'));
}

function desinstalarSkill() {
  const dir = rutaSkill();
  if (!seguro.dentroDe(P.skills, dir)) throw new Error('Ruta de skill inválida.');
  if (!statSafe(dir)) return { ok: true };
  for (const f of ['SKILL.md', 'catalogo.json']) {
    const x = path.join(dir, f);
    if (statSafe(x)) fs.unlinkSync(x);
  }
  try { fs.rmdirSync(dir); } catch { /* quedo algo adentro: se deja */ }
  return { ok: true };
}

module.exports = {
  catalogo, instalarSkill, skillInstalada, desinstalarSkill, NOMBRE_SKILL, rutaSkill,
  porProyecto, leerMemoria, guardarMemoria, borrarMemoria, actualizarIndice,
  candidatos, paqueteContexto, armarMemoria, prepararPrompt,
};
