'use strict';
const fs = require('fs');
const path = require('path');
const { P, readJSON, listDir, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Hooks de Claude Code.
//
// Viven en settings.json bajo `hooks`, con esta forma:
//   { "PreToolUse": [ { matcher: "Grep|Glob",
//                       hooks: [ { type: "command", command: "...", timeout: 5 } ] } ] }
// El `matcher` es una expresion regular contra el nombre de la herramienta
// (PreToolUse/PostToolUse) o contra el motivo del evento (SessionStart).
//
// Los scripts sueltos van en ~/.claude/hooks/ y se referencian por ruta.

// Eventos que soporta Claude Code, con lo que recibe cada uno.
const EVENTOS = [
  { id: 'PreToolUse', usaMatcher: true,
    desc: 'Antes de ejecutar una herramienta. Puede bloquearla.',
    matcherDe: 'nombre de la herramienta', ejemploMatcher: 'Bash|Write' },
  { id: 'PostToolUse', usaMatcher: true,
    desc: 'Despues de que una herramienta termina.',
    matcherDe: 'nombre de la herramienta', ejemploMatcher: 'Edit|Write' },
  { id: 'UserPromptSubmit', usaMatcher: false,
    desc: 'Cuando enviás un mensaje. Puede inyectar contexto.' },
  { id: 'SessionStart', usaMatcher: true,
    desc: 'Al abrir, reanudar, limpiar o compactar una sesión.',
    matcherDe: 'motivo', ejemploMatcher: 'startup' },
  { id: 'SessionEnd', usaMatcher: false, desc: 'Al cerrar la sesión.' },
  { id: 'Stop', usaMatcher: false, desc: 'Cuando Claude termina de responder.' },
  { id: 'SubagentStop', usaMatcher: false, desc: 'Cuando termina un subagente.' },
  { id: 'PreCompact', usaMatcher: false, desc: 'Antes de compactar el contexto.' },
  { id: 'Notification', usaMatcher: false, desc: 'Cuando Claude te notifica algo.' },
];

// Plantillas listas para usar. Son ejemplos reales, no rellenos: cada una
// resuelve algo concreto que se pide seguido.
const PLANTILLAS = [
  {
    id: 'formato-al-guardar',
    titulo: 'Formatear al guardar',
    para: 'Corre el formateador cada vez que Claude edita o crea un archivo.',
    evento: 'PostToolUse', matcher: 'Edit|Write',
    command: 'npx prettier --write "$CLAUDE_FILE_PATHS" 2>/dev/null || true',
    timeout: 30,
  },
  {
    id: 'bloquear-secretos',
    titulo: 'Bloquear escritura de secretos',
    para: 'Impide que se escriba en .env o archivos de credenciales.',
    evento: 'PreToolUse', matcher: 'Write|Edit',
    command: 'case "$CLAUDE_FILE_PATHS" in *.env*|*credentials*|*.pem) echo "bloqueado: archivo sensible" >&2; exit 2;; esac',
    timeout: 5,
  },
  {
    id: 'tests-al-editar',
    titulo: 'Correr tests al tocar código',
    para: 'Ejecuta la suite después de cada edición y avisa si algo se rompió.',
    evento: 'PostToolUse', matcher: 'Edit|Write',
    command: 'npm test --silent 2>&1 | tail -20',
    timeout: 120,
  },
  {
    id: 'aviso-al-terminar',
    titulo: 'Avisar cuando termina',
    para: 'Notificación del sistema al terminar de responder.',
    evento: 'Stop', matcher: '',
    command: 'powershell -c "[console]::beep(880,200)"',
    timeout: 5,
  },
  {
    id: 'contexto-de-git',
    titulo: 'Inyectar el estado de git',
    para: 'Agrega la rama y los cambios sin commitear al arrancar la sesión.',
    evento: 'SessionStart', matcher: 'startup',
    command: 'git branch --show-current 2>/dev/null && git status --short 2>/dev/null | head -20',
    timeout: 10,
  },
  {
    id: 'bitacora',
    titulo: 'Registrar cada comando',
    para: 'Deja un log de todos los comandos de shell que se ejecutan.',
    evento: 'PreToolUse', matcher: 'Bash',
    command: 'echo "$(date -Iseconds) $CLAUDE_TOOL_INPUT" >> ~/.claude/bitacora-bash.log',
    timeout: 5,
  },
];

// Si el archivo EXISTE pero no parsea (una coma de mas, un comentario), no se
// puede tratar como vacio: guardar encima borraria permissions, env y model
// sin avisar. Se distingue "no existe" de "no se entiende".
function leerSettings(file) {
  if (!statSafe(file)) return {};
  let crudo;
  try { crudo = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('No pude leer ' + path.basename(file) + ': ' + e.message); }
  if (!crudo.trim()) return {};
  try { return JSON.parse(crudo); }
  catch {
    throw new Error(
      path.basename(file) + ' tiene un error de sintaxis y no se puede editar sin perder su contenido. ' +
      'Corregilo a mano primero.'
    );
  }
}

function guardar(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

// Si el respaldo falla por algo que no sea "el archivo no existe", se aborta:
// devolver una ruta de backup vacia y escribir igual es peor que no escribir.
function respaldar(userDataDir, file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(userDataDir, 'backups', stamp);
  fs.mkdirSync(dest, { recursive: true });
  try {
    fs.writeFileSync(path.join(dest, path.basename(file)), fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('No se pudo respaldar ' + path.basename(file) + ': ' + e.message);
  }
  return dest;
}

function list() {
  const reglas = [];
  for (const [archivo, file] of [['settings.json', P.settings], ['settings.local.json', P.settingsLocal]]) {
    const s = leerSettings(file);
    for (const [evento, entradas] of Object.entries(s.hooks || {})) {
      (entradas || []).forEach((e, iGrupo) => {
        (e.hooks || []).forEach((h, iHook) => {
          reglas.push({
            id: `${archivo}|${evento}|${iGrupo}|${iHook}`,
            archivo, evento,
            matcher: e.matcher || '',
            type: h.type || 'command',
            command: h.command || '',
            timeout: h.timeout || null,
          });
        });
      });
    }
  }

  const scripts = listDir(P.hooks).filter((f) => f.isFile()).map((f) => {
    const full = path.join(P.hooks, f.name);
    const st = statSafe(full);
    let head = '';
    try { head = fs.readFileSync(full, 'utf8').slice(0, 400); } catch { /* binario */ }
    // Un script al que no apunta ninguna regla no se ejecuta nunca.
    const usado = reglas.some((r) => r.command.includes(f.name));
    return { name: f.name, path: full, bytes: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, head, usado };
  });

  return { reglas, scripts, eventos: EVENTOS, plantillas: PLANTILLAS, dirScripts: P.hooks };
}

// --- escritura ---------------------------------------------------------------

function archivoDe(nombre) {
  return nombre === 'settings.local.json' ? P.settingsLocal : P.settings;
}

// Agrega una regla. Si ya hay un grupo con el mismo matcher en ese evento, se
// suma ahí en vez de crear otro duplicado.
function agregar(userDataDir, { archivo, evento, matcher, command, timeout }) {
  if (!EVENTOS.some((e) => e.id === evento)) throw new Error('Evento desconocido: ' + evento);
  if (!String(command || '').trim()) throw new Error('Falta el comando.');
  const file = archivoDe(archivo);
  const backupPath = respaldar(userDataDir, file);
  const s = leerSettings(file);
  s.hooks = s.hooks || {};
  s.hooks[evento] = s.hooks[evento] || [];

  const nuevo = { type: 'command', command: String(command).trim() };
  if (timeout) nuevo.timeout = Number(timeout);

  const m = String(matcher || '').trim();
  const grupo = s.hooks[evento].find((g) => (g.matcher || '') === m);
  if (grupo) {
    grupo.hooks = grupo.hooks || [];
    grupo.hooks.push(nuevo);
  } else {
    const g = { hooks: [nuevo] };
    if (m) g.matcher = m;
    s.hooks[evento].push(g);
  }
  guardar(file, s);
  return { backupPath };
}

// Los ids son posicionales (archivo|evento|grupo|hook). Un indice negativo
// llegaba a splice() y borraba desde el final: hay que validarlo.
function indice(v, largo) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= largo) return -1;
  return n;
}

function editar(userDataDir, id, cambios) {
  const [archivo, evento, iGrupo, iHook] = String(id).split('|');
  const file = archivoDe(archivo);
  const backupPath = respaldar(userDataDir, file);
  const s = leerSettings(file);
  const lista = (s.hooks || {})[evento] || [];
  const g = indice(iGrupo, lista.length);
  const grupo = g >= 0 ? lista[g] : null;
  const h = grupo ? indice(iHook, (grupo.hooks || []).length) : -1;
  const hook = h >= 0 ? grupo.hooks[h] : null;
  if (!hook) throw new Error('Esa regla ya no existe: recargá la lista.');

  if (cambios.matcher != null) {
    const m = String(cambios.matcher).trim();
    if (m) grupo.matcher = m; else delete grupo.matcher;
  }
  if (cambios.command != null) hook.command = String(cambios.command).trim();
  if (cambios.timeout != null) {
    const t = Number(cambios.timeout);
    if (t > 0) hook.timeout = t; else delete hook.timeout;
  }
  guardar(file, s);
  return { backupPath };
}

function eliminar(userDataDir, id) {
  const [archivo, evento, iGrupo, iHook] = String(id).split('|');
  const file = archivoDe(archivo);
  const backupPath = respaldar(userDataDir, file);
  const s = leerSettings(file);
  const lista = (s.hooks || {})[evento] || [];
  const g = indice(iGrupo, lista.length);
  const grupo = g >= 0 ? lista[g] : null;
  const h = grupo ? indice(iHook, (grupo.hooks || []).length) : -1;
  if (!grupo || h < 0) throw new Error('Esa regla ya no existe: recargá la lista.');
  grupo.hooks.splice(h, 1);
  // Se limpian los niveles que quedaron vacíos para no dejar basura.
  if (!grupo.hooks.length) lista.splice(g, 1);
  if (!lista.length) delete s.hooks[evento];
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  guardar(file, s);
  return { backupPath };
}

// --- scripts -----------------------------------------------------------------

function leerScript(nombre) {
  const file = seguro.unirSeguro(P.hooks, nombre);
  if (!file || !statSafe(file)) throw new Error('No existe ese script.');
  return { name: nombre, path: file, content: fs.readFileSync(file, 'utf8') };
}

function guardarScript(nombre, contenido) {
  const file = seguro.unirSeguro(P.hooks, nombre);
  if (!file) throw new Error('Nombre de script inválido.');
  fs.mkdirSync(P.hooks, { recursive: true });
  // Un symlink dentro de hooks/ que apunte afuera haria que esto escriba del
  // otro lado: se resuelve la ruta real antes de tocar nada.
  if (!seguro.destinoRealSeguro(P.hooks, file)) {
    throw new Error('Ese destino sale de ~/.claude/hooks (¿es un enlace simbólico?).');
  }
  if (statSafe(file)) fs.writeFileSync(file + '.bak', fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, contenido);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o755); } catch { /* mejor esfuerzo */ }
  }
  return leerScript(nombre);
}

function borrarScript(nombre) {
  const file = seguro.unirSeguro(P.hooks, nombre);
  if (!file || !seguro.dentroDe(P.hooks, file)) throw new Error('Solo se borran scripts de ~/.claude/hooks.');
  fs.rmSync(file, { force: true });
  return { name: nombre };
}

module.exports = {
  list, agregar, editar, eliminar,
  leerScript, guardarScript, borrarScript,
  EVENTOS, PLANTILLAS,
};
