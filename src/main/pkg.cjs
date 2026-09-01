'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P, readJSON, listDir, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Paquete portable del setup de Claude Code: MCPs, skills, workflows, hooks,
// proyectos (con receta de indexado) y memorias.
//
// Reglas que se respetan a proposito:
//   - las rutas viajan con ${HOME}, nunca "C:/Users/<vos>/..."
//   - los archivos (skills, workflows, scripts de hooks, memorias) viajan con
//     su CONTENIDO adentro: una referencia suelta llega rota a la otra maquina
//   - los indices del grafo NO viajan (megabytes y rutas locales): viaja la
//     receta para regenerarlos
//   - nunca se exporta ni credenciales ni la cuenta
//   - al importar NUNCA se marca un proyecto como confiado: esa decision de
//     seguridad la toma el usuario en Claude Code, no un archivo importado

const SCHEMA_VERSION = 1;
const KIND = 'claude-cockpit-package';
const HOME = os.homedir();

// --- rutas portables --------------------------------------------------------

function toPortable(p) {
  if (!p) return p;
  const s = String(p).replace(/\\/g, '/');
  const home = HOME.replace(/\\/g, '/');
  return s.toLowerCase().startsWith(home.toLowerCase())
    ? '${HOME}' + s.slice(home.length)
    : s;
}

function fromPortable(p) {
  if (!p) return p;
  return String(p).replace(/^\$\{HOME\}/, HOME.replace(/\\/g, '/'));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function encodeProjectDir(p) {
  return String(p).replace(/[:\\/_]/g, '-');
}

// --- exportar ---------------------------------------------------------------

// La pantalla promete "nunca incluye credenciales", pero el codigo copiaba
// `env` tal cual. Hoy no se filtra nada solo porque tus servidores de usuario
// no tienen variables; el dia que agregues uno con un token (GitHub, Supabase,
// un PAT de Azure DevOps) el paquete se lo llevaba.
//
// Se conservan los NOMBRES de las variables, que es lo que el que importa
// necesita saber para completarlas, y se borra el valor. No se intenta
// adivinar cual es secreta: en una definicion de MCP casi siempre lo son, y
// equivocarse para el lado de mostrar es el error caro.
const VALOR_TAPADO = '';

function envSinSecretos(env) {
  if (!env || typeof env !== 'object') return null;
  const claves = Object.keys(env);
  if (!claves.length) return null;
  const out = {};
  for (const k of claves) out[k] = VALOR_TAPADO;
  return out;
}

function collectMcp(cj) {
  const out = [];
  for (const [name, d] of Object.entries(cj.mcpServers || {})) {
    // Los conectores de claude.ai no se pueden transferir: cada persona
    // autoriza el suyo desde su cuenta.
    if (/^claude\.ai /i.test(name)) continue;
    out.push({
      name,
      scope: 'user',
      type: d.type || (d.url ? 'http' : 'stdio'),
      command: d.command ? toPortable(d.command) : null,
      url: d.url || null,
      args: d.args || [],
      env: envSinSecretos(d.env),
      envPedidas: d.env ? Object.keys(d.env) : [],
    });
  }
  const file = readJSON(P.mcpJson, {}) || {};
  for (const [name, d] of Object.entries(file.mcpServers || {})) {
    if (out.some((s) => s.name === name)) continue;
    out.push({
      name, scope: 'mcpjson',
      type: d.type || (d.url ? 'http' : 'stdio'),
      command: d.command ? toPortable(d.command) : null,
      url: d.url || null, args: d.args || [],
      env: envSinSecretos(d.env),
      envPedidas: d.env ? Object.keys(d.env) : [],
    });
  }
  return out;
}

function collectSkills() {
  const out = [];
  for (const d of listDir(P.skills)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(P.skills, d.name);
    const files = {};
    const walk = (rel) => {
      for (const f of listDir(path.join(dir, rel))) {
        const r = rel ? rel + '/' + f.name : f.name;
        if (f.isDirectory()) walk(r);
        else {
          const txt = readText(path.join(dir, r));
          if (txt != null) files[r] = txt;
        }
      }
    };
    walk('');
    if (Object.keys(files).length) out.push({ name: d.name, scope: 'user', files });
  }
  return out;
}

function collectWorkflows() {
  const out = [];
  for (const f of listDir(P.workflows)) {
    if (!f.isFile()) continue;
    const content = readText(path.join(P.workflows, f.name));
    if (content != null) out.push({ file: f.name, content });
  }
  return out;
}

function collectHooks() {
  const user = readJSON(P.settings, {}) || {};
  const scripts = {};
  for (const f of listDir(P.hooks)) {
    if (!f.isFile()) continue;
    const content = readText(path.join(P.hooks, f.name));
    if (content != null) scripts[f.name] = content;
  }
  return { config: user.hooks || {}, scripts };
}

function collectProjects(cj, indexedProjects) {
  const seen = new Set();
  const out = [];
  const byRoot = new Map();
  for (const ip of indexedProjects || []) {
    if (ip.rootPath) byRoot.set(String(ip.rootPath).replace(/\\/g, '/').toLowerCase(), ip);
  }
  for (const [p, v] of Object.entries(cj.projects || {})) {
    const abs = path.resolve(p);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const live = byRoot.get(abs.replace(/\\/g, '/').toLowerCase());
    const hasArtifact = !!statSafe(path.join(abs, '.codebase-memory', 'artifact.json'));
    const hasGraphify = !!statSafe(path.join(abs, 'graphify-out'));
    out.push({
      path: toPortable(abs),
      allowedTools: (v && v.allowedTools) || [],
      mcpServers: Object.keys((v && v.mcpServers) || {}),
      // Receta, no datos: el indice pesa megabytes y esta atado a este disco.
      index: (live || hasArtifact || hasGraphify) ? {
        provider: hasGraphify ? 'graphify' : 'codebase-memory',
        nodes: live ? live.nodes : null,
        edges: live ? live.edges : null,
      } : null,
    });
  }
  return out;
}

function collectMemory() {
  const out = [];
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const roots = Object.keys(cj.projects || {}).map((p) => path.resolve(p));
  for (const d of listDir(P.projects)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(P.projects, d.name, 'memory');
    const files = {};
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      const txt = readText(path.join(dir, f.name));
      if (txt != null) files[f.name] = txt;
    }
    if (!Object.keys(files).length) continue;
    // Se guarda la ruta real del proyecto para poder recodificarla al importar.
    const root = roots.find((r) => encodeProjectDir(r).toLowerCase() === d.name.toLowerCase());
    out.push({ projectDir: d.name, projectPath: root ? toPortable(root) : null, files });
  }
  return out;
}

// Los tableros propios viven en la carpeta de datos de la app, no en ~/.claude,
// asi que hay que pasarle la ruta.
function collectBoards(dir) {
  if (!dir) return [];
  const file = path.join(dir, 'boards.json');
  const d = readJSON(file, null);
  if (!d || !Array.isArray(d.boards)) return [];
  return d.boards.map((b) => ({
    id: b.id,
    nombre: b.nombre,
    columnas: b.columnas || [],
    // Se lleva el contenido entero: un tablero sin sus tarjetas no sirve.
    tarjetas: (b.tarjetas || []).map((t) => ({ ...t })),
  }));
}

// De los plugins viaja el marketplace (que es un repo git) y cuales estan
// habilitados. Los archivos NO: se vuelven a clonar del repo, que es la fuente.
function collectPlugins() {
  const settings = readJSON(P.settings, {}) || {};
  const habilitados = settings.enabledPlugins || {};
  const out = [];
  const dirMk = path.join(P.plugins, 'marketplaces');
  for (const d of listDir(dirMk)) {
    if (!d.isDirectory()) continue;
    const manifest = readJSON(path.join(dirMk, d.name, '.claude-plugin', 'marketplace.json'), null)
      || readJSON(path.join(dirMk, d.name, 'marketplace.json'), null);
    const repo = (manifest && (manifest.repo || manifest.source)) || null;
    out.push({
      name: d.name,
      repo,
      description: (manifest && manifest.description) || null,
      // Solo los que estan prendidos: la lista completa puede tener cientos.
      habilitados: Object.keys(habilitados)
        .filter((k) => habilitados[k] && k.endsWith('@' + d.name)),
    });
  }
  return out;
}

function build(opts) {
  const o = opts || {};
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const sections = {};

  if (o.mcpServers !== false) sections.mcpServers = collectMcp(cj);
  if (o.skills !== false) sections.skills = collectSkills();
  if (o.workflows !== false) sections.workflows = collectWorkflows();
  if (o.hooks !== false) sections.hooks = collectHooks();
  if (o.projects !== false) sections.projects = collectProjects(cj, o.indexedProjects);
  if (o.memory === true) sections.memory = collectMemory();
  if (o.plugins !== false) sections.plugins = collectPlugins();
  if (o.boards !== false) sections.boards = collectBoards(o.boardsDir);

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      machineLabel: o.machineLabel || os.hostname(),
      platform: process.platform,
      appVersion: o.appVersion || '1.0.0',
      claudeCodeVersion: o.claudeCodeVersion || null,
    },
    sections,
  };
}

function summarize(pkg) {
  const s = pkg.sections || {};
  return {
    mcpServers: (s.mcpServers || []).length,
    skills: (s.skills || []).length,
    workflows: (s.workflows || []).length,
    hooks: Object.keys((s.hooks && s.hooks.scripts) || {}).length,
    hookRules: Object.values((s.hooks && s.hooks.config) || {}).reduce((a, v) => a + (v || []).length, 0),
    projects: (s.projects || []).length,
    memory: (s.memory || []).reduce((a, m) => a + Object.keys(m.files).length, 0),
    plugins: (s.plugins || []).length,
    pluginsHabilitados: (s.plugins || []).reduce((a, m) => a + (m.habilitados || []).length, 0),
    boards: (s.boards || []).length,
    boardCards: (s.boards || []).reduce((a, b) => a + (b.tarjetas || []).length, 0),
  };
}

// --- planificar la importacion ---------------------------------------------

function fileAction(target, content) {
  const cur = readText(target);
  if (cur == null) return 'agrega';
  return cur === content ? 'igual' : 'pisa';
}

// Las rutas de los CAMPOS de configuracion se parametrizan con ${HOME}, pero
// dentro del CONTENIDO de un script o de una memoria no se toca nada: reescribir
// el archivo de otro es peor que avisarle. Se detecta y se avisa.
const RUTA_USUARIO = /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)([A-Za-z0-9._-]+)/g;
const USUARIO_LOCAL = path.basename(HOME).toLowerCase();

function avisoDeRutas(...contenidos) {
  const ajenos = new Set();
  for (const c of contenidos) {
    if (typeof c !== 'string') continue;
    for (const m of c.matchAll(RUTA_USUARIO)) {
      if (m[1] && m[1].toLowerCase() !== USUARIO_LOCAL) ajenos.add(m[1]);
    }
  }
  if (!ajenos.size) return null;
  return 'Menciona rutas de otro usuario (' + [...ajenos].join(', ') +
    '): revisá el contenido después de importar';
}

function plan(pkg) {
  if (!pkg || pkg.kind !== KIND) {
    throw new Error('El archivo no es un paquete de Claude Cockpit.');
  }
  if (pkg.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Paquete de otra versión (v${pkg.schemaVersion}); esta app entiende la v${SCHEMA_VERSION}.`);
  }

  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const settings = readJSON(P.settings, {}) || {};
  const s = pkg.sections || {};
  const out = {};

  out.mcpServers = (s.mcpServers || []).map((m) => {
    const existente = (cj.mcpServers || {})[m.name];
    const cmd = m.command ? fromPortable(m.command) : null;
    // Si el binario no esta, importarlo deja un MCP que falla en silencio.
    const falta = cmd && /[\\/]/.test(cmd) && !statSafe(cmd);
    return {
      id: m.name,
      label: m.name,
      detail: cmd || m.url || '',
      action: existente ? (JSON.stringify(existente.command) === JSON.stringify(cmd) ? 'igual' : 'pisa') : 'agrega',
      warning: falta
        ? 'El programa no existe en esta máquina: ' + cmd
        : ((m.envPedidas || []).length
          ? 'Vas a tener que completar ' + m.envPedidas.join(', ') + ': los valores no viajan en el paquete'
          : null),
    };
  });

  out.skills = (s.skills || []).map((sk) => {
    const dir = path.join(P.skills, sk.name);
    const existe = !!statSafe(dir);
    return {
      id: sk.name, label: sk.name,
      detail: Object.keys(sk.files).length + ' archivos',
      action: existe ? 'pisa' : 'agrega',
      warning: avisoDeRutas(...Object.values(sk.files)),
    };
  });

  out.plugins = (s.plugins || []).map((m) => {
    const dir = path.join(P.plugins, 'marketplaces', m.name);
    const existe = !!statSafe(dir);
    return {
      id: m.name,
      label: m.name,
      detail: (m.habilitados || []).length + ' habilitados' + (m.repo ? ' · ' + m.repo : ''),
      action: existe ? 'igual' : 'agrega',
      warning: m.repo ? null : 'Sin repo en el manifiesto: habrá que agregarlo a mano',
    };
  });

  out.boards = (s.boards || []).map((b) => ({
    id: b.id,
    label: b.nombre,
    detail: (b.tarjetas || []).length + ' tarjetas · ' + (b.columnas || []).length + ' columnas',
    // Se importan como tableros NUEVOS: pisar uno propio con el de otro seria
    // perder trabajo sin poder deshacerlo.
    action: 'agrega',
    warning: null,
  }));

  out.workflows = (s.workflows || []).map((w) => ({
    id: w.file, label: w.file,
    detail: Math.round(w.content.length / 1024) + ' KB',
    action: fileAction(path.join(P.workflows, w.file), w.content),
    warning: avisoDeRutas(w.content),
  }));

  const hookScripts = (s.hooks && s.hooks.scripts) || {};
  out.hooks = Object.entries(hookScripts).map(([name, content]) => ({
    id: name, label: name,
    detail: 'script',
    action: fileAction(path.join(P.hooks, name), content),
    warning: avisoDeRutas(content),
  }));
  const reglas = Object.entries((s.hooks && s.hooks.config) || {});
  if (reglas.length) {
    out.hooks.push({
      id: '__config__',
      label: 'reglas de hooks en settings.json',
      detail: reglas.map(([ev, arr]) => `${ev} (${(arr || []).length})`).join(', '),
      action: settings.hooks ? 'fusiona' : 'agrega',
      warning: null,
    });
  }

  out.projects = (s.projects || []).map((p) => {
    const abs = fromPortable(p.path);
    const existeEnDisco = !!statSafe(abs);
    const yaRegistrado = Object.keys(cj.projects || {}).some(
      (k) => path.resolve(k).toLowerCase() === path.resolve(abs).toLowerCase()
    );
    return {
      id: p.path, label: abs,
      detail: (p.index ? `indexar con ${p.index.provider}` : 'sin índice'),
      action: yaRegistrado ? 'igual' : 'agrega',
      warning: existeEnDisco ? null : 'La carpeta no existe acá: se registra igual pero vas a tener que clonarla',
    };
  });

  out.memory = (s.memory || []).map((m) => {
    const abs = m.projectPath ? fromPortable(m.projectPath) : null;
    const destino = abs ? encodeProjectDir(abs) : m.projectDir;
    const dir = path.join(P.projects, destino, 'memory');
    const existentes = listDir(dir).filter((f) => f.isFile()).length;
    return {
      id: m.projectDir,
      label: abs || m.projectDir,
      detail: Object.keys(m.files).length + ' recuerdos',
      action: existentes ? 'fusiona' : 'agrega',
      warning: avisoDeRutas(...Object.values(m.files)),
    };
  });

  return out;
}

// --- aplicar ----------------------------------------------------------------

function backup(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, 'backups', stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const src of [P.CLAUDE_JSON, P.settings, P.mcpJson]) {
    const txt = readText(src);
    if (txt != null) fs.writeFileSync(path.join(dest, path.basename(src)), txt);
  }
  return dest;
}

function writeFileSafe(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Escribe SOLO si el destino cae dentro de `base`. Los nombres vienen de un
// archivo que te pasaron: sin esto, una skill llamada "../../.." escribe donde
// quiera del disco.
function escribirDentro(base, partes, content, errores, etiqueta) {
  const destino = seguro.unirSeguro(base, ...partes);
  if (!destino) {
    errores.push('ruta rechazada en ' + etiqueta + ': ' + partes.join('/'));
    return false;
  }
  writeFileSafe(destino, content);
  return true;
}

// Ids nuevos para las tarjetas importadas, con el mismo formato que usa
// boards.cjs.
function idNuevo() {
  return require('crypto').randomBytes(8).toString('hex');
}

function apply(pkg, selection, backupDir, boardsDir) {
  const sel = selection || {};
  const s = pkg.sections || {};
  const hecho = [];
  const errores = [];
  const backupPath = backup(backupDir);

  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  let tocaClaudeJson = false;

  const permitido = (seccion, id) => {
    const lista = sel[seccion];
    return Array.isArray(lista) && lista.includes(id);
  };

  try {
    for (const m of s.mcpServers || []) {
      if (!permitido('mcpServers', m.name)) continue;
      cj.mcpServers = cj.mcpServers || {};
      const def = {};
      if (m.command) def.command = fromPortable(m.command);
      if (m.url) def.url = m.url;
      if (m.type && m.type !== 'stdio') def.type = m.type;
      if (m.args && m.args.length) def.args = m.args;
      if (m.env) def.env = m.env;
      cj.mcpServers[m.name] = def;
      tocaClaudeJson = true;
      hecho.push('MCP ' + m.name);
    }

    for (const sk of s.skills || []) {
      if (!permitido('skills', sk.name)) continue;
      let ok = true;
      for (const [rel, content] of Object.entries(sk.files)) {
        if (!escribirDentro(P.skills, [sk.name, rel], content, errores, 'skill ' + sk.name)) ok = false;
      }
      if (ok) hecho.push('skill ' + sk.name);
    }

    for (const w of s.workflows || []) {
      if (!permitido('workflows', w.file)) continue;
      if (escribirDentro(P.workflows, [w.file], w.content, errores, 'workflow')) {
        hecho.push('workflow ' + w.file);
      }
    }

    for (const [name, content] of Object.entries((s.hooks && s.hooks.scripts) || {})) {
      if (!permitido('hooks', name)) continue;
      const file = seguro.unirSeguro(P.hooks, name);
      if (!file) { errores.push('ruta rechazada en hook: ' + name); continue; }
      writeFileSafe(file, content);
      // En Linux/macOS un hook sin permiso de ejecucion no corre.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(file, 0o755); } catch { /* mejor esfuerzo */ }
      }
      hecho.push('hook ' + name);
    }

    if (permitido('hooks', '__config__') && s.hooks && s.hooks.config) {
      const settings = readJSON(P.settings, {}) || {};
      settings.hooks = settings.hooks || {};
      for (const [evento, entradas] of Object.entries(s.hooks.config)) {
        const actuales = settings.hooks[evento] || [];
        const nuevas = (entradas || []).filter(
          (e) => !actuales.some((a) => JSON.stringify(a) === JSON.stringify(e))
        );
        settings.hooks[evento] = actuales.concat(nuevas);
      }
      writeFileSafe(P.settings, JSON.stringify(settings, null, 2));
      hecho.push('reglas de hooks');
    }

    for (const p of s.projects || []) {
      if (!permitido('projects', p.path)) continue;
      const abs = fromPortable(p.path);
      cj.projects = cj.projects || {};
      const previo = cj.projects[abs] || {};
      cj.projects[abs] = Object.assign({}, previo, {
        allowedTools: p.allowedTools || previo.allowedTools || [],
        // hasTrustDialogAccepted NO se toca a proposito: confiar en una carpeta
        // es una decision de seguridad que tenes que tomar vos en Claude Code,
        // no algo que herede un archivo que te pasaron.
      });
      tocaClaudeJson = true;
      hecho.push('proyecto ' + path.basename(abs));
    }

    // Los tableros propios se importan SIEMPRE como nuevos, con id nuevo:
    // pisar un tablero tuyo con el de otro seria perder trabajo sin vuelta.
    if ((s.boards || []).length && boardsDir) {
      const fileBoards = path.join(boardsDir, 'boards.json');
      const datos = readJSON(fileBoards, null) || { boards: [] };
      datos.boards = datos.boards || [];
      let sumados = 0;
      for (const b of s.boards) {
        if (!permitido('boards', b.id)) continue;
        const mapa = new Map();
        const nuevo = {
          id: idNuevo(),
          nombre: b.nombre,
          columnas: (b.columnas || []).map((c) => ({ ...c })),
          tarjetas: [],
          creado: new Date().toISOString(),
        };
        for (const t of b.tarjetas || []) {
          const id2 = idNuevo();
          mapa.set(t.id, id2);
          nuevo.tarjetas.push({ ...t, id: id2, padre: null });
        }
        // Los padres se enlazan recien con todas las tarjetas creadas.
        for (const t of b.tarjetas || []) {
          if (!t.padre) continue;
          const hijo = nuevo.tarjetas.find((x) => x.id === mapa.get(t.id));
          const padre = mapa.get(t.padre);
          if (hijo && padre) hijo.padre = padre;
        }
        datos.boards.push(nuevo);
        sumados++;
        hecho.push('tablero ' + b.nombre);
      }
      if (sumados) writeFileSafe(fileBoards, JSON.stringify(datos, null, 2));
    }

    // De los plugins solo se marca cuales van habilitados. Clonar el
    // marketplace es una descarga de red y una decision aparte: se hace desde
    // el panel de Plugins, que ya sabe validar el repo.
    const plugsElegidos = (s.plugins || []).filter((m) => permitido('plugins', m.name));
    if (plugsElegidos.length) {
      const settings = readJSON(P.settings, {}) || {};
      settings.enabledPlugins = settings.enabledPlugins || {};
      let tocados = 0;
      for (const m of plugsElegidos) {
        const dir = path.join(P.plugins, 'marketplaces', m.name);
        if (!statSafe(dir)) {
          errores.push('el marketplace "' + m.name + '" no está clonado en esta máquina' +
            (m.repo ? ': agregalo desde Plugins (' + m.repo + ')' : ''));
          continue;
        }
        for (const id of m.habilitados || []) {
          if (!String(id).endsWith('@' + m.name)) continue;   // no se cuela otro marketplace
          settings.enabledPlugins[id] = true;
          tocados++;
        }
        hecho.push('plugins de ' + m.name);
      }
      if (tocados) writeFileSafe(P.settings, JSON.stringify(settings, null, 2));
    }

    for (const m of s.memory || []) {
      if (!permitido('memory', m.projectDir)) continue;
      const abs = m.projectPath ? fromPortable(m.projectPath) : null;
      const destino = abs ? encodeProjectDir(abs) : m.projectDir;
      let ok = true;
      for (const [name, content] of Object.entries(m.files)) {
        if (!escribirDentro(P.projects, [destino, 'memory', name], content, errores, 'memoria')) ok = false;
      }
      if (ok) hecho.push('memorias de ' + (abs ? path.basename(abs) : m.projectDir));
    }

    if (tocaClaudeJson) {
      writeFileSafe(P.CLAUDE_JSON, JSON.stringify(cj, null, 2));
    }
  } catch (e) {
    errores.push(String(e.message || e));
  }

  return { backupPath, hecho, errores };
}

module.exports = {
  envSinSecretos, collectBoards, collectPlugins,
  SCHEMA_VERSION, KIND,
  build, summarize, plan, apply, toPortable, fromPortable,
};
