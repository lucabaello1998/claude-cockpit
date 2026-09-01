'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, nativeImage } = require('electron');
const path = require('path');
const chokidar = require('chokidar');
const { Store } = require('../src/main/store.cjs');
const liveUsage = require('../src/main/sources/liveUsage.cjs');
const { AppSettings } = require('../src/main/appSettings.cjs');
const graph = require('../src/main/mcpGraph.cjs');
const pkg = require('../src/main/pkg.cjs');
const pricing = require('../src/main/sources/pricing.cjs');
const pricingFetch = require('../src/main/sources/pricingFetch.cjs');
const projectsEdit = require('../src/main/projectsEdit.cjs');
const mcpRegistry = require('../src/main/mcpRegistry.cjs');
const skillsEdit = require('../src/main/skillsEdit.cjs');
const pluginsEdit = require('../src/main/pluginsEdit.cjs');
const hooksEdit = require('../src/main/hooksEdit.cjs');
const skillsRegistry = require('../src/main/skillsRegistry.cjs');
const boards = require('../src/main/boards.cjs');
const requisitos = require('../src/main/requisitos.cjs');
const briefing = require('../src/main/briefing.cjs');
const updater = require('../src/main/updater.cjs');
const instalacion = require('../src/main/instalacion.cjs');
const contexto = require('../src/main/contexto.cjs');
const workflowsEdit = require('../src/main/workflowsEdit.cjs');
const workflowTemplates = require('../src/main/workflowTemplates.cjs');
const mcpClient = require('../src/main/mcpClient.cjs');
const { P } = require('../src/main/sources/paths.cjs');
const seguro = require('../src/main/safePaths.cjs');

const isDev = process.env.COCKPIT_DEV === '1';
let win = null;
let store = null;
let watcher = null;
let refreshTimer = null;
let settings = null;
let syncWatcher = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// El PNG vive en build/ y se incluye en el paquete; si no esta, se devuelve
// undefined y Electron usa el suyo.
function iconoDeVentana() {
  const f = path.join(__dirname, '..', 'build', 'icon.png');
  try { return require('fs').existsSync(f) ? f : undefined; } catch { return undefined; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f0f0e',
    title: 'Claude Cockpit',
    // En el .exe empaquetado Windows usa el icono del ejecutable, pero en
    // desarrollo (y en Linux) la ventana quedaba con el de Electron.
    icon: iconoDeVentana(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Los errores del renderer no llegan al proceso principal por si solos:
  // sin esto, un crash de React se ve como una ventana en negro y nada mas.
  win.webContents.on('console-message', (_e, nivel, mensaje, linea, fuente) => {
    if (nivel >= 2) console.error(`[renderer] ${mensaje}  (${fuente}:${linea})`);
  });
  win.webContents.on('render-process-gone', (_e, det) => {
    console.error('[renderer] el proceso murio:', JSON.stringify(det));
  });
  win.webContents.on('preload-error', (_e, f, err) => {
    console.error('[preload]', f, err && err.message);
  });

  // Abrir enlaces externos en el navegador, nunca dentro de la ventana.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (seguro.urlPermitida(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // La ventana solo muestra la app. Si algo intenta navegarla a otro lado
  // (un enlace suelto, contenido de un transcript), se cancela.
  win.webContents.on('will-navigate', (e, url) => {
    const permitida = isDev ? url.startsWith('http://localhost:5173') : url.startsWith('file://');
    if (!permitida) {
      e.preventDefault();
      if (seguro.urlPermitida(url)) shell.openExternal(url);
    }
  });

  // Defensa en profundidad: aunque el contenido se renderiza con React (que
  // escapa por defecto), una CSP evita que algo pegado en un transcript
  // termine cargando codigo o llamando afuera.
  win.webContents.session.webRequest.onHeadersReceived((det, cb) => {
    cb({
      responseHeaders: Object.assign({}, det.responseHeaders, {
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "img-src 'self' data:; " +
          "style-src 'self' 'unsafe-inline'; " +
          `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}; ` +
          "connect-src 'self'" + (isDev ? ' ws://localhost:5173 http://localhost:5173' : '') + '; ' +
          "object-src 'none'; base-uri 'none'; form-action 'none'",
        ],
      }),
    });
  });
}

// --- auto-actualizacion ----------------------------------------------------

// Reindexa con debounce: Claude Code escribe el transcript en cada token,
// asi que sin agrupar los eventos reindexariamos decenas de veces por segundo.
function scheduleRefresh(reason) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const r = await store.refresh();
      // Si instalaste la skill, su catálogo se mantiene solo. Solo si ya
      // existe: crearla sin que la pidas sería escribir en tu configuración
      // por la nuestra.
      if (contexto.skillInstalada()) {
        try { await contexto.instalarSkill(); }
        catch { /* si falla, el catálogo queda viejo y la skill lo dice */ }
      }
      send('cockpit:updated', { reason, ...r, at: Date.now() });
    } catch (e) {
      send('cockpit:error', { where: 'refresh', message: String(e && e.message || e) });
    }
  }, 1200);
}

function startWatching() {
  watcher = chokidar.watch(
    [
      P.projects,
      P.CLAUDE_JSON,
      P.settings,
      P.settingsLocal,
      P.mcpJson,
      P.mcpAuthCache,
      P.sessionMeta,
      P.facets,
      P.history,
      P.workflows,
      P.skills,
    ],
    {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      depth: 8,
    }
  );
  watcher.on('all', (event, file) => scheduleRefresh(`${event}:${path.basename(file)}`));
  watcher.on('error', (e) =>
    send('cockpit:error', { where: 'watcher', message: String(e && e.message || e) })
  );
}

// Vigila la carpeta compartida: cuando la notebook publica su digest, el
// escritorio lo levanta sin que tengas que apretar nada.
function watchSyncDir() {
  if (syncWatcher) { syncWatcher.close(); syncWatcher = null; }
  const dir = settings.get().syncDir;
  if (!dir) return;
  syncWatcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
  });
  syncWatcher.on('all', (_e, file) => {
    if (/digest-.*\.json$/.test(file)) scheduleRefresh('sync:' + path.basename(file));
  });
  syncWatcher.on('error', (e) =>
    send('cockpit:error', { where: 'sync', message: String(e && e.message || e) })
  );
}

// --- IPC -------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      // Al renderer va solo el mensaje. El stack completo queda en la consola
      // del proceso principal: sirve para depurar sin exponer rutas internas
      // en la interfaz.
      if (process.env.COCKPIT_DEV === '1') console.error(`[${channel}]`, e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

handle('snapshot', () => store.getSnapshot());
handle('refresh', async () => {
  await store.refresh();
  return store.getSnapshot();
});
handle('session', (id, opts) => store.getSession(id, opts));
handle('threadImage', (id, ref) => store.getImage(id, ref));
handle('agentThread', (file, opts) => store.getAgentThread(file, opts));
handle('agentImage', (file, ref) => store.getAgentImage(file, ref));
handle('search', (q, opts) => store.search(q, opts));
handle('memory', () => store.getMemory());
// Solo se dispara cuando el usuario aprieta el boton de actualizar uso.
handle('liveUsage', (forzar) => liveUsage.fetchUsage({ forzar: !!forzar }));

// --- sincronizacion entre maquinas ---
handle('getSettings', () => Object.assign(settings.get(), {
  machineId: store.identity.machineId,
  machineLabel: store.machineLabel(),
}));
handle('setSettings', async (patch) => {
  const before = settings.get().syncDir;
  const after = settings.set(patch);
  if (after.syncDir !== before) watchSyncDir();
  await store.refresh();
  return after;
});
handle('pickSyncDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Carpeta compartida para los digests',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  settings.set({ syncDir: r.filePaths[0] });
  watchSyncDir();
  await store.refresh();
  return r.filePaths[0];
});
handle('publishDigest', () => store.publishDigest());

// Archivar es solo una preferencia de la vista: no toca los transcripts ni
// obliga a reindexar, por eso no pasa por setSettings.
handle('toggleArchived', (sessionId) => {
  const list = settings.get().archived || [];
  const next = list.includes(sessionId)
    ? list.filter((x) => x !== sessionId)
    : list.concat([sessionId]);
  settings.set({ archived: next });
  return next;
});
handle('getArchived', () => settings.get().archived || []);

// --- precios ---
handle('pricingInfo', () => ({
  info: pricing.info(),
  showCosts: settings.get().showCosts !== false,
  consentAt: settings.get().consentAt || null,
  docUrl: pricingFetch.URL_DOC,
}));

// Baja la tabla de la doc oficial pero NO la aplica: devuelve el diff para que
// el usuario confirme. Aplicar precios en silencio haria mentir todos los
// numeros sin que nadie se entere.
handle('pricingFetchRemote', async () => {
  const remoto = await pricingFetch.fetchPricing();
  const actual = pricing.info().models;
  const cambios = [];
  for (const [id, m] of Object.entries(remoto.models)) {
    const a = actual[id];
    if (!a) { cambios.push({ id, label: m.label, de: null, a: `${m.input}/${m.output}`, tipo: 'nuevo' }); continue; }
    if (a.input !== m.input || a.output !== m.output) {
      cambios.push({ id, label: m.label, de: `${a.input}/${a.output}`, a: `${m.input}/${m.output}`, tipo: 'cambia' });
    }
  }
  return { tabla: remoto, cambios };
});

handle('pricingApply', async (tabla) => {
  const info = pricing.setTable(tabla);
  settings.set({ pricing: tabla });
  store.snapshot = store._build();
  return info;
});

handle('pricingReset', async () => {
  const info = pricing.setTable(null);
  settings.set({ pricing: null });
  store.snapshot = store._build();
  return info;
});

handle('setShowCosts', (v) => { settings.set({ showCosts: !!v }); return !!v; });

// --- edicion de proyectos en ~/.claude.json ---
// Cada operacion respalda el archivo y lo relee antes de escribir, porque
// Claude Code tambien escribe ahi.
const ud = () => app.getPath('userData');
handle('projectsList', () => projectsEdit.list());

// --- servidores MCP a nivel usuario + registro oficial ---
handle('mcpSetUser', async (name, def) => {
  const r = projectsEdit.setUserMcp(ud(), name, def);
  await store.refresh();
  return r;
});
handle('mcpRemoveUser', async (name) => {
  const r = projectsEdit.removeUserMcp(ud(), name);
  await store.refresh();
  return r;
});
handle('mcpRenameUser', async (a, b) => {
  const r = projectsEdit.renameUserMcp(ud(), a, b);
  await store.refresh();
  return r;
});
handle('mcpSearchRegistry', (q, cursor) => mcpRegistry.search(q, cursor));

// --- skills ---
const { readJSON: leerJson } = require('../src/main/sources/paths.cjs');
handle('skillsList', () => skillsEdit.listar(leerJson(P.CLAUDE_JSON, {}) || {}));

// --- directorio skills.sh ---
handle('skillsSearch', (q) => skillsRegistry.search(q));
handle('skillsDetail', (s) => skillsRegistry.detalle(s));
handle('skillsInstall', async (nombre, contenido) => {
  const r = skillsRegistry.instalar(nombre, contenido);
  await store.refresh();
  return r;
});
handle('skillRead', (dir) => skillsEdit.read(dir));
handle('skillSave', async (dir, cambios) => {
  const r = skillsEdit.save(dir, cambios);
  await store.refresh();
  return r;
});
handle('skillCreate', async (nombre, desc, body) => {
  const r = skillsEdit.crear(nombre, desc, body);
  await store.refresh();
  return r;
});
handle('skillDelete', async (dir) => {
  const r = skillsEdit.eliminar(dir);
  await store.refresh();
  return r;
});
handle('skillFork', async (dir, nombre) => {
  const r = skillsEdit.copiarAMisSkills(dir, nombre);
  await store.refresh();
  return r;
});

// --- plugins y marketplaces ---
handle('pluginsList', () => pluginsEdit.list());

// --- hooks ---
handle('hooksList', () => hooksEdit.list());

// --- workflows ---
// Las plantillas viajan ya analizadas para poder dibujarlas sin guardarlas.
handle('workflowsList', () => ({
  workflows: workflowsEdit.list(),
  dir: workflowsEdit.dir,
  tutorial: workflowTemplates.TUTORIAL,
  plantillas: workflowTemplates.PLANTILLAS.map((p) => Object.assign({}, p, {
    analisis: workflowsEdit.analizar(p.codigo),
  })),
}));
handle('workflowRead', (f) => workflowsEdit.leer(f));
handle('workflowSave', async (f, c) => { const r = workflowsEdit.guardar(f, c); await store.refresh(); return r; });
handle('workflowDelete', async (f) => { const r = workflowsEdit.borrar(f); await store.refresh(); return r; });

// --- boards ---
const dirBoards = () => path.join(app.getPath('userData'), 'boards');
handle('boardsProviders', () => boards.proveedores());
handle('boardsList', () => boards.listarLocales(dirBoards()));
handle('boardGet', (id) => boards.obtenerLocal(dirBoards(), id));
handle('boardCreate', (n, c) => boards.crearBoard(dirBoards(), n, c));
handle('boardDelete', (id) => boards.borrarBoard(dirBoards(), id));
handle('boardSaveColumns', (id, c) => boards.guardarColumnas(dirBoards(), id, c));
handle('boardSaveCard', (id, t) => boards.guardarTarjeta(dirBoards(), id, t));
handle('boardMoveCard', (id, t, c) => boards.moverTarjeta(dirBoards(), id, t, c));
handle('boardDeleteCard', (id, t) => boards.borrarTarjeta(dirBoards(), id, t));
handle('boardComment', (id, t, texto) => boards.comentarLocal(dirBoards(), id, t, texto));
handle('boardDeleteComment', (id, t, c) => boards.borrarComentarioLocal(dirBoards(), id, t, c));
handle('boardImport', (remoto, nombre) => boards.importarComoLocal(dirBoards(), remoto, nombre));
handle('adoConnection', () => require('../src/main/ado.cjs').conexion());
handle('reqStatus', () => requisitos.estado());
handle('installState', () => instalacion.estado());
handle('contextByProject', () => contexto.porProyecto());
handle('contextCatalog', () => contexto.catalogo());
handle('skillStatus', () => ({
  instalada: contexto.skillInstalada(),
  nombre: contexto.NOMBRE_SKILL,
  dir: contexto.rutaSkill(),
}));
handle('skillInstall', () => contexto.instalarSkill());
handle('skillUninstall', () => contexto.desinstalarSkill());
handle('memoryRead', (proj, file) => contexto.leerMemoria(proj, file));
handle('memorySave', async (proj, datos) => {
  const r = contexto.guardarMemoria(proj, datos);
  await store.refresh();
  return r;
});
handle('memoryDelete', async (proj, file) => {
  const r = contexto.borrarMemoria(proj, file);
  await store.refresh();
  return r;
});
handle('contextCandidates', (file) => contexto.candidatos(file));
handle('contextPrompt', (sesion, proj) => contexto.prepararPrompt(sesion, proj));
handle('updaterState', () => updater.publico());
handle('updaterCheck', () => updater.buscar());
handle('updaterDownload', () => updater.descargar());
handle('updaterInstall', () => updater.instalar());
handle('briefing', async (forzar) => {
  const snap = await store.getSnapshot();
  return briefing.obtener(snap, ud(), dirBoards(), !!forzar);
});
handle('reqConfigure', async (id, valores, opcion) => {
  const r = requisitos.configurar(ud(), id, valores, opcion);
  await store.refresh();
  return r;
});
handle('reqTest', (id) => requisitos.probar(id));
handle('adoProjects', () => boards.adoProyectos());
handle('adoTeams', (p) => boards.adoEquipos(p));
handle('adoSprints', (p, e) => boards.adoSprints(p, e));
handle('adoStates', (p, tipo) => boards.adoEstados(p, tipo));
handle('adoBoard', (p, e, filtros) => boards.adoTablero(p, e, filtros));
handle('adoDetail', (p, id) => boards.adoDetalle(p, id));
handle('adoSetState', (p, id, estado) => boards.adoCambiarEstado(p, id, estado));
handle('adoAssign', (p, id, quien) => boards.adoAsignar(p, id, quien));
handle('adoComment', (p, id, texto) => boards.adoComentar(p, id, texto));
handle('jiraProjects', () => boards.jiraProyectos());
handle('jiraBoard', (p) => boards.jiraTablero(p));
handle('hookAdd', async (d) => { const r = hooksEdit.agregar(ud(), d); await store.refresh(); return r; });
handle('hookEdit', async (id, c) => { const r = hooksEdit.editar(ud(), id, c); await store.refresh(); return r; });
handle('hookDelete', async (id) => { const r = hooksEdit.eliminar(ud(), id); await store.refresh(); return r; });
handle('hookScriptRead', (n) => hooksEdit.leerScript(n));
handle('hookScriptSave', async (n, c) => { const r = hooksEdit.guardarScript(n, c); await store.refresh(); return r; });
handle('hookScriptDelete', async (n) => { const r = hooksEdit.borrarScript(n); await store.refresh(); return r; });
handle('pluginSetEnabled', async (id, v) => {
  const r = pluginsEdit.setEnabled(id, v);
  await store.refresh();
  return r;
});
handle('marketplaceAdd', async (repo) => {
  const r = await pluginsEdit.addMarketplace(repo);
  await store.refresh();
  return r;
});
handle('marketplaceUpdate', async (n) => {
  const r = await pluginsEdit.updateMarketplace(n);
  await store.refresh();
  return r;
});
handle('marketplaceRemove', async (n) => {
  const r = pluginsEdit.removeMarketplace(n);
  await store.refresh();
  return r;
});
handle('projectSetTrust', async (ruta, v) => {
  const r = projectsEdit.setTrust(ud(), ruta, v);
  await store.refresh();
  return r;
});
handle('projectSetTools', async (ruta, tools) => {
  const r = projectsEdit.setAllowedTools(ud(), ruta, tools);
  await store.refresh();
  return r;
});
handle('projectSetMcp', async (ruta, servers) => {
  const r = projectsEdit.setProjectMcp(ud(), ruta, servers);
  await store.refresh();
  return r;
});
handle('projectsMerge', async (rutas, ganadora, trust) => {
  const r = projectsEdit.mergeDuplicates(ud(), rutas, ganadora, trust);
  await store.refresh();
  return r;
});
handle('projectRemove', async (ruta) => {
  const r = projectsEdit.removeProject(ud(), ruta);
  await store.refresh();
  return r;
});
handle('acceptConsent', () => { settings.set({ consentAt: new Date().toISOString() }); return true; });

// --- explorador del grafo de codigo (habla con el MCP por stdio) ---
handle('graphAvailable', () => graph.available());
handle('graphProjects', () => graph.projects());
handle('graphArchitecture', (project) => graph.architecture(project));
handle('graphSearch', (project, opts) => graph.search(project, opts));
handle('graphSnippet', (project, qn, neighbors) => graph.snippet(project, qn, neighbors));
handle('graphTrace', (project, fn, opts) => graph.trace(project, fn, opts));
handle('graphSubgraph', (project, opts) => graph.subgraph(project, opts));
handle('graphSchema', (project) => graph.schema(project));

// --- paquete portable del setup ---
// `pendiente` guarda el paquete abierto entre la vista previa y el aplicar,
// para no re-leer el archivo ni confiar en lo que mande el renderer.
let pendiente = null;

async function armarPaquete(incluir) {
  let indexedProjects = [];
  try { indexedProjects = await graph.projects(); } catch { /* sin MCP, sin recetas */ }
  return pkg.build(Object.assign({}, incluir, {
    machineLabel: store.machineLabel(),
    indexedProjects,
    // Los tableros propios no viven en ~/.claude sino en los datos de la app.
    boardsDir: dirBoards(),
    claudeCodeVersion: (store.snapshot && store.snapshot.sessions[0] && store.snapshot.sessions[0].version) || null,
  }));
}

handle('pkgPreview', async (incluir) => {
  const p = await armarPaquete(incluir);
  return { counts: pkg.summarize(p), sizeBytes: Buffer.byteLength(JSON.stringify(p)) };
});

handle('pkgExport', async (incluir) => {
  const p = await armarPaquete(incluir);
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar el paquete',
    defaultPath: `claude-setup-${store.machineLabel()}.cockpitpkg.json`,
    filters: [{ name: 'Paquete de Claude Cockpit', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  require('fs').writeFileSync(r.filePath, JSON.stringify(p, null, 2));
  return r.filePath;
});

handle('pkgOpen', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir un paquete',
    properties: ['openFile'],
    filters: [{ name: 'Paquete de Claude Cockpit', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const raw = require('fs').readFileSync(r.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  const plan = pkg.plan(parsed);   // valida kind y schemaVersion, tira si no
  pendiente = parsed;
  return { plan, info: parsed.exportedFrom || {}, file: r.filePaths[0] };
});

handle('pkgApply', async (seleccion) => {
  if (!pendiente) throw new Error('No hay ningún paquete abierto.');
  const p = pendiente;
  // Se limpia antes de aplicar: si algo falla a mitad, no queda un paquete
  // colgado que se pueda reaplicar por accidente.
  pendiente = null;
  const res = pkg.apply(p, seleccion, app.getPath('userData'), dirBoards());
  await store.refresh();
  return res;
});
// El renderer puede pedir abrir cualquier cosa: se acota a las carpetas que la
// app maneja (config de Claude, proyectos registrados, temp y su propia
// carpeta de datos). No hay motivo para que abra C:\\Windows\\System32.
function extraPermitidas() {
  return [app.getPath('userData'), settings && settings.get().syncDir].filter(Boolean);
}

handle('openPath', async (p) => {
  if (!seguro.rutaPermitida(p, extraPermitidas())) {
    throw new Error('Esa ruta está fuera de las carpetas que maneja la app.');
  }
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return true;
});
handle('revealPath', (p) => {
  if (!seguro.rutaPermitida(p, extraPermitidas())) {
    throw new Error('Esa ruta está fuera de las carpetas que maneja la app.');
  }
  shell.showItemInFolder(p);
  return true;
});
handle('openExternal', (url) => {
  // Solo http/https/mailto: file:// abriria cualquier cosa del disco y otros
  // esquemas pueden disparar aplicaciones registradas del sistema.
  if (!seguro.urlPermitida(url)) throw new Error('Solo se abren enlaces http, https o mailto.');
  return shell.openExternal(url);
});
handle('paths', () => ({
  claudeDir: P.CLAUDE_DIR,
  claudeJson: P.CLAUDE_JSON,
  projects: P.projects,
  usageData: P.usageData,
}));

// --- arranque --------------------------------------------------------------

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  settings = new AppSettings(app.getPath('userData'));
  // Si guardaste una tabla de precios propia, se aplica antes del primer indexado.
  if (settings.get().pricing) { try { pricing.setTable(settings.get().pricing); } catch { /* tabla invalida */ } }
  store = new Store(path.join(app.getPath('userData'), 'cache'), settings);
  // Miniaturas con la API de Electron: sin dependencias nativas extra.
  // Una captura de 230 KB baja a ~15 KB, y el hilo entero deja de pesar 26 MB.
  store.setThumbnailer((base64, media) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      if (img.isEmpty()) return null;
      const { width } = img.getSize();
      const chica = width > 360 ? img.resize({ width: 360, quality: 'good' }) : img;
      return 'data:image/jpeg;base64,' + chica.toJPEG(70).toString('base64');
    } catch {
      return null;
    }
  });
  createWindow();
  // El actualizador avisa cambios por su cuenta (progreso de descarga, etc.).
  updater.iniciar(app, (estado) => send('cockpit:updater', estado));
  // primer indexado en segundo plano: la ventana ya se ve mientras corre
  store
    .refresh((p) => send('cockpit:indexing', p))
    .then((r) => send('cockpit:updated', { reason: 'arranque', ...r, at: Date.now() }))
    .catch((e) => send('cockpit:error', { where: 'boot', message: String(e && e.message || e) }));
  startWatching();
  watchSyncDir();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  mcpClient.detenerTodos();
  // El servidor de grafo es un proceso hijo: si no se cierra explicitamente
  // puede quedar vivo despues de cerrar la ventana.
  graph.stop();
  if (watcher) watcher.close();
  if (syncWatcher) syncWatcher.close();
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (syncWatcher) syncWatcher.close();
  graph.stop();
  if (process.platform !== 'darwin') app.quit();
});
