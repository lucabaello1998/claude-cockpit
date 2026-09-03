'use strict';
const fs = require('fs');
const path = require('path');
const { P, statSafe } = require('./sources/paths.cjs');
const memoria = require('./sources/memory.cjs');
const transcripts = require('./sources/transcripts.cjs');
const contexto = require('./contexto.cjs');
const seguro = require('./safePaths.cjs');

// Llevarte contexto elegido a mano: a una sesion nueva, o a otra maquina.
//
// El catalogo que ya existe (contexto.catalogo) es automatico y completo: sirve
// para que una sesion pregunte "que hay". Esto es lo contrario: vos elegis, y
// sale una carpeta que se puede copiar a un pendrive.
//
// Por que una CARPETA y no un .zip: Node no trae escritura de zip, y meter una
// dependencia nueva para esto seria pagar caro algo que Windows ya hace con
// clic derecho. Ademas la carpeta se puede abrir y mirar antes de mandarsela a
// alguien, que con transcripts adentro no es un detalle menor.
//
// Las cuatro cosas que se pueden llevar NO se importan igual, y el manifiesto
// lo dice explicito para que del otro lado no se adivine:
//
//   memorias / CLAUDE.md  copiar el archivo y listo, Claude Code los lee solo
//   conversaciones        el .jsonl solo se puede retomar si la ruta coincide
//   grafos                casi siempre conviene reindexar, no copiar 18 MB
//
// El modo "autocontenido" es la diferencia entre los dos casos de uso: para la
// misma maquina alcanzan los punteros, porque los archivos pesados ya estan en
// el disco; para otra maquina hay que copiarlos de verdad.

const VERSION_PAQUETE = 1;

// --- que se puede llevar -----------------------------------------------------

// Se arma sobre porProyecto(), que ya cruza memorias con CLAUDE.md y ya sabe
// resolver el projectDir codificado a una ruta real. Lo unico que se agrega
// aca son las sesiones, que viven en el snapshot del store.
async function inventario(sesiones) {
  const proyectos = await contexto.porProyecto();
  const m = await memoria.readAll();

  const porDir = new Map();
  for (const s of sesiones || []) {
    if (!s || !s.projectDir) continue;
    if (!porDir.has(s.projectDir)) porDir.set(s.projectDir, []);
    porDir.get(s.projectDir).push({
      sessionId: s.sessionId,
      file: s.file,
      titulo: s.title || s.firstPrompt || '(sin título)',
      desde: s.startedAt || null,
      hasta: s.endedAt || null,
      turnos: s.userTurns || 0,
      bytes: s.sizeBytes || 0,
      rama: s.gitBranch || null,
      cwd: s.cwd || null,
    });
  }

  const salida = [];
  for (const p of proyectos) {
    const ses = (porDir.get(p.projectDir) || [])
      .sort((a, b) => String(b.desde || '').localeCompare(String(a.desde || '')));
    // Un proyecto sin nada de nada no da opciones: solo ensucia la lista.
    if (!p.memorias.length && !p.claudeMd && !ses.length) continue;
    salida.push({
      projectDir: p.projectDir,
      projectPath: p.projectPath,
      nombre: p.nombre,
      memorias: p.memorias.map((e) => ({
        id: p.projectDir + '/' + e.file,
        file: e.file,
        nombre: e.name,
        descripcion: e.description,
        tipo: e.type || 'project',
        bytes: e.bytes || 0,
      })),
      claudeMd: p.claudeMd ? { id: p.projectDir + '/CLAUDE.md', ...p.claudeMd } : null,
      sesiones: ses,
    });
  }

  // Los grafos se listan aparte porque no cuelgan de un projectDir sino de un
  // repo, y porque la decision de llevarlos es distinta: son megabytes.
  const grafos = [];
  for (const prov of m.providers || []) {
    for (const st of prov.stores || []) {
      grafos.push({
        id: prov.id + '/' + st.name,
        proveedor: prov.id,
        etiqueta: prov.label,
        nombre: st.name,
        repo: st.root || null,
        dir: st.dir || null,
        nodos: st.nodes || null,
        aristas: st.edges || null,
        indexadoEn: st.indexedAt || null,
        commitIndexado: st.indexedCommit || null,
        desactualizado: !!st.stale,
        bytes: pesoDe(st.dir),
      });
    }
  }

  return { proyectos: salida.sort((a, b) => a.nombre.localeCompare(b.nombre)), grafos };
}

function pesoDe(dir) {
  if (!dir) return 0;
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) total += pesoDe(full);
      else { const st = statSafe(full); if (st) total += st.size; }
    }
  } catch { /* sin permiso o no existe */ }
  return total;
}

// --- armar el paquete --------------------------------------------------------

function carpetaNueva(destino) {
  const st = statSafe(destino);
  if (!st || !st.isDirectory()) throw new Error('Esa carpeta de destino no existe.');
  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  let dir = path.join(destino, 'cockpit-paquete-' + sello);
  // Dos exportaciones en el mismo minuto no se pisan.
  let n = 2;
  while (statSafe(dir)) dir = path.join(destino, 'cockpit-paquete-' + sello + '-' + n++);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Todo lo que se escribe adentro del paquete pasa por aca: los nombres vienen
// de projectDir y de nombres de archivo del disco, asi que se validan igual que
// si los hubiera tipeado alguien.
function destinoSeguro(raiz, ...partes) {
  const p = seguro.unirSeguro(raiz, ...partes);
  if (!p || !seguro.dentroDe(raiz, p)) throw new Error('Ruta inválida dentro del paquete.');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function copiar(origen, destino) {
  const st = statSafe(origen);
  if (!st) return 0;
  fs.copyFileSync(origen, destino);
  return st.size;
}

function copiarArbol(origen, destino) {
  let total = 0;
  fs.mkdirSync(destino, { recursive: true });
  for (const f of fs.readdirSync(origen, { withFileTypes: true })) {
    // Un symlink adentro del store apuntaria a cualquier lado al copiarlo.
    if (f.isSymbolicLink()) continue;
    const o = path.join(origen, f.name);
    const d = path.join(destino, f.name);
    if (f.isDirectory()) total += copiarArbol(o, d);
    else if (f.isFile()) total += copiar(o, d);
  }
  return total;
}

// Cuantos mensajes tuyos entran en el resumen. Una sesion larga puede tener
// cientos; el resumen tiene que seguir siendo algo que se lee, no el transcript
// de nuevo. Los del medio son los que menos se extranan.
const TOPE_TURNOS = 80;

// Tus propios mensajes, en orden, sin los que mete el harness.
//
// candidatos() de contexto.cjs filtra ademas por senales (regex de "acordate",
// "no hagas", "decidimos"). Probado contra una sesion real de 393 mensajes
// tuyos devolvio CERO: 47 quedaban en rango de largo y ninguno matcheaba,
// porque lo que escribis son pedidos normales. Asi que aca no se filtra por
// senales: se lleva todo lo que dijiste y se deja que el que lea decida. El
// filtro fino lo hace el modelo despues, no una regex.
async function turnosTuyos(file) {
  const hilo = await transcripts.loadThread(file, { limit: 100000, includeSidechain: false });
  const mensajes = Array.isArray(hilo) ? hilo : (hilo.messages || []);
  const out = [];
  for (const m of mensajes) {
    if (m.role !== 'user') continue;
    if (m.isToolReturn || m.injected || m.isConversation === false) continue;
    const texto = (m.blocks || [])
      .filter((b) => b && b.type === 'text' && b.text)
      .map((b) => b.text).join('\n').trim().replace(/\s+/g, ' ');
    if (texto.length < 15) continue;
    // Un mensaje enorme es casi siempre un pegado de logs o de codigo.
    out.push({ ts: m.ts || null, texto: texto.length > 600 ? texto.slice(0, 600) + '…' : texto });
  }
  return out;
}

// El resumen de una conversacion es lo unico que Cockpit no puede hacer bien:
// no tiene modelo. Asi que no se inventa un resumen — se deja la metadata, la
// materia prima que si se puede sacar sin modelo, y el pedido listo para que lo
// corras en Claude Code, que es donde esta el modelo que ya pagaste.
async function resumenDeSesion(ses, projectDir) {
  const l = [];
  l.push('# ' + (ses.titulo || ses.sessionId));
  l.push('');
  l.push('- **Sesión:** `' + ses.sessionId + '`');
  if (ses.cwd) l.push('- **Proyecto:** ' + ses.cwd);
  if (ses.rama) l.push('- **Rama:** ' + ses.rama);
  if (ses.desde) l.push('- **Cuándo:** ' + String(ses.desde).slice(0, 16).replace('T', ' '));
  l.push('- **Tamaño:** ' + ses.turnos + ' turnos tuyos · '
    + Math.round((ses.bytes || 0) / 1024) + ' KB de transcript');
  l.push('');

  let turnos = [];
  try { turnos = await turnosTuyos(ses.file); }
  catch { /* transcript ilegible o borrado: el resumen igual sirve */ }

  l.push('## Lo que pediste, en orden');
  l.push('');
  if (turnos.length) {
    l.push('_Son tus mensajes tal cual, sin las devoluciones de herramientas ni lo que');
    l.push('inyecta el harness. Es materia prima: la conversación entera resumida no está');
    l.push('acá, porque para eso hace falta un modelo._');
    l.push('');
    // De una sesion larga se llevan las dos puntas: como arranco y como
    // termino es lo que reconstruye el hilo. El medio se puede releer del
    // transcript si esta, y si no esta tampoco lo ibas a leer.
    const recortar = turnos.length > TOPE_TURNOS;
    const mitad = Math.floor(TOPE_TURNOS / 2);
    const elegidos = recortar
      ? [...turnos.slice(0, mitad), null, ...turnos.slice(-mitad)]
      : turnos;
    for (const t of elegidos) {
      if (t === null) {
        l.push('');
        l.push('_(… ' + (turnos.length - TOPE_TURNOS) + ' mensajes del medio, en el transcript completo …)_');
        l.push('');
        continue;
      }
      l.push('- ' + t.texto);
    }
  } else {
    l.push('_No se pudo leer el transcript: puede haberse borrado._');
  }
  l.push('');
  l.push('## Para sacar lo bueno de verdad');
  l.push('');
  l.push('Corré esto en Claude Code, que sí tiene modelo:');
  l.push('');
  l.push(contexto.prepararPrompt({ file: ses.file }, projectDir)
    .split('\n').map((x) => '    ' + x).join('\n'));
  l.push('');
  return l.join('\n');
}

async function exportar({ destino, seleccion, autocontenido, sesiones, etiquetaMaquina }) {
  const sel = seleccion || {};
  const pedidoMem = new Set(sel.memorias || []);
  const pedidoMd = new Set(sel.claudeMd || []);
  const pedidoSes = new Set(sel.sesiones || []);
  const pedidoGrafos = new Set(sel.grafos || []);
  if (!pedidoMem.size && !pedidoMd.size && !pedidoSes.size && !pedidoGrafos.size) {
    throw new Error('No elegiste nada para llevar.');
  }

  const inv = await inventario(sesiones);
  const dir = carpetaNueva(destino);
  let bytes = 0;

  const man = {
    version: VERSION_PAQUETE,
    generadoEn: new Date().toISOString(),
    generadoPor: 'claude-cockpit',
    maquinaOrigen: etiquetaMaquina || null,
    // La diferencia entre "me lo llevo a otra maquina" y "lo traigo a una
    // sesion nueva aca". Del otro lado cambia todo lo que se puede hacer.
    autocontenido: !!autocontenido,
    proyectos: [],
    grafos: [],
  };

  for (const p of inv.proyectos) {
    const mem = p.memorias.filter((e) => pedidoMem.has(e.id));
    const llevaMd = !!(p.claudeMd && pedidoMd.has(p.claudeMd.id));
    const ses = p.sesiones.filter((s) => pedidoSes.has(s.sessionId));
    if (!mem.length && !llevaMd && !ses.length) continue;

    const entrada = {
      projectDir: p.projectDir,
      nombre: p.nombre,
      // La ruta original importa: el nombre de la carpeta de transcripts es el
      // cwd codificado, asi que sin esto no se sabe donde va cada cosa.
      rutaOriginal: p.projectPath || null,
      memorias: [],
      claudeMd: null,
      conversaciones: [],
    };

    for (const e of mem) {
      const origen = path.join(P.projects, p.projectDir, 'memory', e.file);
      const dest = destinoSeguro(dir, 'memorias', p.projectDir, e.file);
      bytes += copiar(origen, dest);
      entrada.memorias.push({
        archivo: 'memorias/' + p.projectDir + '/' + e.file,
        nombre: e.nombre,
        descripcion: e.descripcion,
        tipo: e.tipo,
        destino: '~/.claude/projects/' + p.projectDir + '/memory/' + e.file,
      });
    }

    if (llevaMd) {
      const dest = destinoSeguro(dir, 'claude-md', p.projectDir, 'CLAUDE.md');
      bytes += copiar(p.claudeMd.path, dest);
      entrada.claudeMd = {
        archivo: 'claude-md/' + p.projectDir + '/CLAUDE.md',
        destino: p.projectPath ? path.join(p.projectPath, 'CLAUDE.md') : null,
        bytes: p.claudeMd.bytes,
      };
    }

    for (const s of ses) {
      const base = 'conversaciones/' + p.projectDir + '/' + s.sessionId;
      const res = destinoSeguro(dir, 'conversaciones', p.projectDir, s.sessionId + '.resumen.md');
      const texto = await resumenDeSesion(s, p.projectDir);
      fs.writeFileSync(res, texto);
      bytes += Buffer.byteLength(texto);

      const fila = {
        sessionId: s.sessionId,
        titulo: s.titulo,
        desde: s.desde,
        hasta: s.hasta,
        turnos: s.turnos,
        resumen: base + '.resumen.md',
        transcript: null,
        rutaOriginal: s.file,
        // Retomar un transcript en otra maquina depende de que el cwd sea el
        // mismo: el nombre de la carpeta se deriva de ahi. Se avisa en vez de
        // prometer que anda.
        retomableSi: p.projectPath || s.cwd || null,
      };
      if (autocontenido) {
        const dst = destinoSeguro(dir, 'conversaciones', p.projectDir, s.sessionId + '.jsonl');
        bytes += copiar(s.file, dst);
        fila.transcript = base + '.jsonl';
      }
      entrada.conversaciones.push(fila);
    }

    man.proyectos.push(entrada);
  }

  for (const g of inv.grafos.filter((x) => pedidoGrafos.has(x.id))) {
    const fila = {
      id: g.id,
      proveedor: g.proveedor,
      nombre: g.nombre,
      repo: g.repo,
      nodos: g.nodos,
      aristas: g.aristas,
      commitIndexado: g.commitIndexado,
      indexadoEn: g.indexadoEn,
      desactualizado: g.desactualizado,
      copiado: null,
      destino: g.dir || null,
      // Sin esto el puntero no sirve: hay que decir con que se consulta y como
      // se regenera, que casi siempre es mejor que copiar los megabytes.
      herramientas: g.proveedor === 'codebase-memory'
        ? ['mcp__codebase-memory-mcp__search_graph', 'mcp__codebase-memory-mcp__trace_path',
          'mcp__codebase-memory-mcp__get_architecture', 'mcp__codebase-memory-mcp__get_code_snippet']
        : [],
      reindexar: g.proveedor === 'codebase-memory'
        ? 'index_repository sobre ' + (g.repo || 'el repo')
        : 'volver a correr graphify sobre ' + (g.repo || 'el repo'),
    };
    if (autocontenido && g.dir && statSafe(g.dir)) {
      const dst = destinoSeguro(dir, 'grafos', g.nombre);
      bytes += copiarArbol(g.dir, dst);
      fila.copiado = 'grafos/' + g.nombre + '/';
    }
    man.grafos.push(fila);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2));
  fs.writeFileSync(path.join(dir, 'LEEME.md'), leeme(man, dir));

  return {
    dir,
    bytes,
    resumen: {
      proyectos: man.proyectos.length,
      memorias: man.proyectos.reduce((a, p) => a + p.memorias.length, 0),
      claudeMd: man.proyectos.filter((p) => p.claudeMd).length,
      conversaciones: man.proyectos.reduce((a, p) => a + p.conversaciones.length, 0),
      grafos: man.grafos.length,
      grafosCopiados: man.grafos.filter((g) => g.copiado).length,
    },
  };
}

// El LEEME es para la persona; el manifest.json es para Claude. Los dos hacen
// falta: si el paquete llega por Drive tres semanas despues, nadie se acuerda
// que tenia adentro.
function plural(n, uno, varios) {
  return n + ' ' + (n === 1 ? uno : varios);
}

function leeme(man, dir) {
  const l = [];
  const mem = man.proyectos.reduce((a, p) => a + p.memorias.length, 0);
  const conv = man.proyectos.reduce((a, p) => a + p.conversaciones.length, 0);
  const mds = man.proyectos.filter((p) => p.claudeMd).length;

  l.push('# Paquete de contexto de Claude Cockpit');
  l.push('');
  l.push('Generado el ' + man.generadoEn.slice(0, 16).replace('T', ' ')
    + (man.maquinaOrigen ? ' en **' + man.maquinaOrigen + '**' : '') + '.');
  l.push('');
  l.push('Contiene ' + plural(mem, 'memoria', 'memorias') + ', '
    + mds + ' CLAUDE.md, ' + plural(conv, 'conversación', 'conversaciones')
    + ' y ' + plural(man.grafos.length, 'grafo', 'grafos') + ', de '
    + plural(man.proyectos.length, 'proyecto', 'proyectos') + '.');
  l.push('');
  l.push(man.autocontenido
    ? 'Es **autocontenido**: los transcripts y los grafos elegidos están adentro, así que sirve para llevarlo a otra máquina.'
    : 'Es **liviano**: solo resúmenes y punteros. Sirve para traer contexto en esta misma máquina, donde los archivos originales siguen estando.');
  l.push('');
  l.push('## Cómo importarlo');
  l.push('');
  l.push('En cualquier sesión de Claude Code:');
  l.push('');
  l.push('    /cockpit-memory importar ' + dir);
  l.push('');
  l.push('Eso lee el `manifest.json`, te muestra qué hay y te pregunta qué querés poner');
  l.push('en su lugar. No copia nada sin que lo confirmes.');
  l.push('');
  l.push('Si no tenés la skill instalada: Claude Cockpit → Contexto → Instalar skill. O');
  l.push('directamente decile a Claude que lea el `manifest.json` de esta carpeta.');
  l.push('');
  l.push('## Qué hay adentro');
  l.push('');
  for (const p of man.proyectos) {
    l.push('### ' + p.nombre);
    l.push('');
    if (p.rutaOriginal) {
      l.push('Ruta original: `' + p.rutaOriginal + '`');
      l.push('');
    }
    for (const e of p.memorias) l.push('- memoria **' + e.nombre + '** — ' + (e.descripcion || ''));
    if (p.claudeMd) l.push('- **CLAUDE.md** del proyecto');
    for (const c of p.conversaciones) {
      l.push('- conversación _' + String(c.titulo).slice(0, 70) + '_'
        + (c.transcript ? ' (con transcript completo)' : ' (solo resumen)'));
    }
    l.push('');
  }
  if (man.grafos.length) {
    l.push('### Grafos de código');
    l.push('');
    for (const g of man.grafos) {
      l.push('- **' + g.nombre + '** (' + g.proveedor + ')'
        + (g.copiado ? ' — copiado entero' : ' — solo el puntero: conviene reindexar')
        + (g.desactualizado ? ' ⚠️ el índice ya estaba desactualizado' : ''));
    }
    l.push('');
  }
  if (conv && man.autocontenido) {
    l.push('---');
    l.push('');
    l.push('**Ojo antes de compartirlo:** un transcript completo es la conversación entera,');
    l.push('con todo lo que se pegó adentro. Si en alguna de esas sesiones pasó una clave,');
    l.push('un token o datos de un cliente, están acá.');
    l.push('');
  }
  return l.join('\n');
}

module.exports = { inventario, exportar, VERSION_PAQUETE, pesoDe };
