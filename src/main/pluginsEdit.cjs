'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { P, readJSON, listDir, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Plugins y marketplaces.
//
// Lo importante: tener el marketplace clonado NO significa tener el plugin
// activo. Claude Code decide con `enabledPlugins` en settings.json, un mapa
// { "<plugin>@<marketplace>": true|false }. Sin esa clave, el plugin no corre
// aunque sus archivos esten en el disco.

const KNOWN = path.join(P.plugins, 'known_marketplaces.json');
const MK_DIR = path.join(P.plugins, 'marketplaces');

function leerSettings() { return readJSON(P.settings, {}) || {}; }

function guardarSettings(s) {
  fs.mkdirSync(path.dirname(P.settings), { recursive: true });
  fs.writeFileSync(P.settings, JSON.stringify(s, null, 2));
}

function manifestDe(dir) {
  return readJSON(path.join(dir, '.claude-plugin', 'marketplace.json'))
    || readJSON(path.join(dir, 'marketplace.json'))
    || null;
}

function list() {
  const known = readJSON(KNOWN, {}) || {};
  const settings = leerSettings();
  const enabled = settings.enabledPlugins || {};

  const marketplaces = [];
  for (const d of listDir(MK_DIR)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(MK_DIR, d.name);
    const man = manifestDe(dir);
    if (!man) continue;
    const info = known[d.name] || {};
    const plugins = (man.plugins || []).map((p) => {
      const id = p.name + '@' + d.name;
      const carpeta = path.join(dir, 'plugins', p.name);
      const local = statSafe(carpeta);
      return {
        id,
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || '',
        category: p.category || null,
        author: (p.author && (p.author.name || p.author)) || null,
        version: p.version || null,
        homepage: p.homepage || null,
        keywords: p.keywords || p.tags || [],
        // enabledPlugins puede decir true, false, o no estar (= apagado)
        enabled: enabled[id] === true,
        explicitlyDisabled: enabled[id] === false,
        // Los que no tienen carpeta se descargan recien al habilitarlos.
        descargado: !!local,
        skillsDeclaradas: (p.skills || []).length,
        path: local ? carpeta : null,
      };
    });
    marketplaces.push({
      name: d.name,
      dir,
      description: man.description || '',
      owner: (man.owner && (man.owner.name || man.owner)) || null,
      repo: (info.source && info.source.repo) || null,
      lastUpdated: info.lastUpdated || null,
      total: plugins.length,
      habilitados: plugins.filter((p) => p.enabled).length,
      plugins,
    });
  }

  return {
    marketplaces,
    settingsFile: P.settings,
    totalHabilitados: Object.values(enabled).filter(Boolean).length,
  };
}

// Escribe enabledPlugins en ~/.claude/settings.json.
// `null` quita la clave (vuelve al comportamiento por defecto: apagado).
function setEnabled(id, valor) {
  const s = leerSettings();
  s.enabledPlugins = s.enabledPlugins || {};
  if (valor === null) delete s.enabledPlugins[id];
  else s.enabledPlugins[id] = !!valor;
  if (!Object.keys(s.enabledPlugins).length) delete s.enabledPlugins;
  guardarSettings(s);
  return { id, valor };
}

// --- marketplaces -----------------------------------------------------------

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message || '').toString().trim().slice(0, 300)));
      else resolve(String(out));
    });
  });
}

// Acepta "owner/repo" o una URL de git completa.
function normalizarRepo(entrada) {
  const s = String(entrada || '').trim();
  if (!s) throw new Error('Falta el repositorio.');
  // "usuario/repo" -> github por https
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { url: `https://github.com/${s}.git`, repo: s };
  // Una URL completa solo si es https o ssh. git soporta transportes como
  // `ext::<comando>` que ejecutan un programa arbitrario: eso no entra.
  if (!seguro.repoGitPermitido(s)) {
    throw new Error('Solo se aceptan "usuario/repo", URLs https:// o git@host:ruta.');
  }
  return { url: s, repo: s.replace(/\.git$/, '').split('/').slice(-2).join('/') };
}

async function addMarketplace(entrada) {
  const { url, repo } = normalizarRepo(entrada);
  const nombre = seguro.segmentoSeguro(repo.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!nombre) throw new Error('Nombre de repositorio inválido.');
  const dest = seguro.unirSeguro(MK_DIR, nombre);
  if (!dest) throw new Error('Nombre de repositorio inválido.');
  if (statSafe(dest)) throw new Error('Ya tenés un marketplace con ese nombre.');

  fs.mkdirSync(MK_DIR, { recursive: true });
  const tmp = dest + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  await git(['clone', '--depth', '1', url, tmp]);

  // Solo se registra si de verdad es un marketplace: si no, queda un directorio
  // clonado que Claude Code no va a poder leer.
  const man = manifestDe(tmp);
  if (!man || !Array.isArray(man.plugins)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('Ese repositorio no tiene un .claude-plugin/marketplace.json válido.');
  }

  fs.renameSync(tmp, dest);
  const known = readJSON(KNOWN, {}) || {};
  known[nombre] = {
    source: { source: 'github', repo },
    installLocation: dest,
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(KNOWN, JSON.stringify(known, null, 2));
  return { nombre, plugins: man.plugins.length, repo };
}

async function updateMarketplace(nombre) {
  const dir = seguro.unirSeguro(MK_DIR, nombre);
  if (!dir || !statSafe(dir)) throw new Error('No existe ese marketplace.');
  await git(['pull', '--ff-only'], dir);
  const known = readJSON(KNOWN, {}) || {};
  if (known[nombre]) {
    known[nombre].lastUpdated = new Date().toISOString();
    fs.writeFileSync(KNOWN, JSON.stringify(known, null, 2));
  }
  const man = manifestDe(dir);
  return { nombre, plugins: (man && man.plugins || []).length };
}

function removeMarketplace(nombre) {
  const dir = seguro.unirSeguro(MK_DIR, nombre);
  if (!dir || !statSafe(dir)) throw new Error('No existe ese marketplace.');
  const known = readJSON(KNOWN, {}) || {};
  delete known[nombre];
  fs.writeFileSync(KNOWN, JSON.stringify(known, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });

  // Deja de referenciar plugins que ya no existen.
  const s = leerSettings();
  if (s.enabledPlugins) {
    for (const k of Object.keys(s.enabledPlugins)) {
      if (k.endsWith('@' + nombre)) delete s.enabledPlugins[k];
    }
    if (!Object.keys(s.enabledPlugins).length) delete s.enabledPlugins;
    guardarSettings(s);
  }
  return { nombre };
}

module.exports = { list, setEnabled, addMarketplace, updateMarketplace, removeMarketplace };
