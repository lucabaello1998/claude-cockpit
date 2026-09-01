'use strict';
const fs = require('fs');
const path = require('path');
const { P, readJSON, statSafe } = require('./sources/paths.cjs');

// Edicion de la configuracion de proyectos dentro de ~/.claude.json.
//
// Es el unico lugar de la app que modifica la config de Claude Code fuera de
// importar un paquete, asi que:
//   - siempre hace backup antes de escribir
//   - se relee el archivo justo antes de tocarlo (Claude Code tambien escribe
//     ahi; si trabajamos sobre una copia vieja le pisariamos cosas)
//   - dar confianza a una carpeta se trata como operacion aparte y explicita

function backup(userDataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(userDataDir, 'backups', stamp);
  fs.mkdirSync(dest, { recursive: true });
  try {
    fs.writeFileSync(path.join(dest, 'claude.json'), fs.readFileSync(P.CLAUDE_JSON, 'utf8'));
  } catch { /* si no se puede leer, no hay nada que respaldar */ }
  return dest;
}

// Relee, aplica el cambio y guarda. Nunca mantiene el JSON en memoria entre
// operaciones para no pisar lo que haya escrito Claude Code mientras tanto.
function mutate(userDataDir, fn) {
  const cj = readJSON(P.CLAUDE_JSON, null);
  if (!cj) throw new Error('No pude leer ~/.claude.json');
  const backupPath = backup(userDataDir);
  cj.projects = cj.projects || {};
  const r = fn(cj);
  fs.writeFileSync(P.CLAUDE_JSON, JSON.stringify(cj, null, 2));
  return Object.assign({ backupPath }, r || {});
}

function normalize(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

// --- lectura ----------------------------------------------------------------

// Campos que Claude Code usa como telemetria de la ultima sesion. No son
// configuracion y no tiene sentido mostrarlos ni tocarlos.
const TELEMETRIA = /^(last|has(Unseen|ClaudeMd))/;

function list() {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const proyectos = Object.entries(cj.projects || {}).map(([ruta, v]) => ({
    path: ruta,
    key: normalize(ruta),
    exists: !!statSafe(ruta),
    trusted: !!v.hasTrustDialogAccepted,
    allowedTools: v.allowedTools || [],
    mcpServers: Object.entries(v.mcpServers || {}).map(([name, def]) => ({
      name,
      type: def.type || (def.url ? 'http' : 'stdio'),
      command: def.command || def.url || null,
      args: def.args || [],
    })),
    enabledMcpjsonServers: v.enabledMcpjsonServers || [],
    disabledMcpjsonServers: v.disabledMcpjsonServers || [],
    otrosCampos: Object.keys(v).filter((k) => !TELEMETRIA.test(k)).length,
  }));

  // Duplicados: la misma carpeta registrada con distinta capitalizacion o
  // separadores. Claude Code las trata como proyectos distintos, asi que una
  // puede estar confiada y la otra no.
  const grupos = new Map();
  for (const p of proyectos) {
    if (!grupos.has(p.key)) grupos.set(p.key, []);
    grupos.get(p.key).push(p);
  }
  const duplicados = [...grupos.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([key, v]) => ({
      key,
      entradas: v,
      difierenEnTrust: new Set(v.map((x) => x.trusted)).size > 1,
    }));

  // Servidores MCP definidos a nivel usuario, para poder ofrecerlos por proyecto.
  const disponibles = Object.entries(cj.mcpServers || {})
    .filter(([n]) => !/^claude\.ai /i.test(n))
    .map(([name, def]) => ({
      name,
      type: def.type || (def.url ? 'http' : 'stdio'),
      command: def.command || def.url || null,
      args: def.args || [],
    }));

  return { proyectos, duplicados, disponibles };
}

// --- escritura --------------------------------------------------------------

function setTrust(userDataDir, ruta, valor) {
  return mutate(userDataDir, (cj) => {
    if (!cj.projects[ruta]) cj.projects[ruta] = {};
    if (valor) cj.projects[ruta].hasTrustDialogAccepted = true;
    else delete cj.projects[ruta].hasTrustDialogAccepted;
    return { ruta, trusted: !!valor };
  });
}

function setAllowedTools(userDataDir, ruta, tools) {
  const limpias = [...new Set((tools || []).map((t) => String(t).trim()).filter(Boolean))];
  return mutate(userDataDir, (cj) => {
    if (!cj.projects[ruta]) cj.projects[ruta] = {};
    cj.projects[ruta].allowedTools = limpias;
    return { ruta, allowedTools: limpias };
  });
}

function setProjectMcp(userDataDir, ruta, servers) {
  return mutate(userDataDir, (cj) => {
    if (!cj.projects[ruta]) cj.projects[ruta] = {};
    const out = {};
    for (const s of servers || []) {
      if (!s || !s.name) continue;
      const def = {};
      if (s.type && s.type !== 'stdio') def.type = s.type;
      if (s.command) def[s.type === 'http' || s.type === 'sse' ? 'url' : 'command'] = s.command;
      if (s.args && s.args.length) def.args = s.args;
      if (s.env) def.env = s.env;
      out[s.name] = def;
    }
    if (Object.keys(out).length) cj.projects[ruta].mcpServers = out;
    else delete cj.projects[ruta].mcpServers;
    return { ruta, mcpServers: Object.keys(out) };
  });
}

// Unifica varias entradas de la misma carpeta en una sola.
// `ganadora` es la ruta que se conserva; el resto se borra.
function mergeDuplicates(userDataDir, rutas, ganadora, trustFinal) {
  return mutate(userDataDir, (cj) => {
    const destino = Object.assign({}, cj.projects[ganadora] || {});
    const tools = new Set(destino.allowedTools || []);
    const mcp = Object.assign({}, destino.mcpServers || {});
    const enabled = new Set(destino.enabledMcpjsonServers || []);
    const disabled = new Set(destino.disabledMcpjsonServers || []);

    for (const r of rutas) {
      if (r === ganadora) continue;
      const v = cj.projects[r] || {};
      for (const t of v.allowedTools || []) tools.add(t);
      for (const [n, d] of Object.entries(v.mcpServers || {})) if (!mcp[n]) mcp[n] = d;
      for (const n of v.enabledMcpjsonServers || []) enabled.add(n);
      for (const n of v.disabledMcpjsonServers || []) disabled.add(n);
      delete cj.projects[r];
    }

    if (tools.size) destino.allowedTools = [...tools]; else delete destino.allowedTools;
    if (Object.keys(mcp).length) destino.mcpServers = mcp; else delete destino.mcpServers;
    if (enabled.size) destino.enabledMcpjsonServers = [...enabled];
    if (disabled.size) destino.disabledMcpjsonServers = [...disabled];

    // La confianza no se hereda sola: la decide quien aprieta el boton.
    if (trustFinal) destino.hasTrustDialogAccepted = true;
    else delete destino.hasTrustDialogAccepted;

    cj.projects[ganadora] = destino;
    return { ganadora, eliminadas: rutas.filter((r) => r !== ganadora) };
  });
}

function removeProject(userDataDir, ruta) {
  return mutate(userDataDir, (cj) => {
    delete cj.projects[ruta];
    return { ruta };
  });
}

// --- servidores MCP a nivel usuario ----------------------------------------

// Los conectores de claude.ai no se tocan desde aca: se autorizan en claude.ai
// y su definicion no vive en este archivo.
// Nombre corto y valido para usar como clave. Es la misma regla que ya estaba
// escrita en mcpRegistry.suggestName, que hasta ahora no la usaba nadie.
const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

function nombreDeServidor(nombre) {
  const limpio = String(nombre).split('/').pop() || String(nombre);
  const n = limpio.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!n) throw new Error('Ese nombre no deja ningún carácter válido.');
  if (CLAVES_PROHIBIDAS.has(n)) throw new Error('Ese nombre está reservado por JavaScript.');
  return n;
}

function setUserMcp(userDataDir, name, def) {
  if (!name || !String(name).trim()) throw new Error('Falta el nombre del servidor.');
  if (/^claude\.ai /i.test(name)) throw new Error('Los conectores de claude.ai se manejan desde claude.ai.');
  // El nombre termina siendo una clave de ~/.claude.json. Venia del panel sin
  // sanear (un id del marketplace tipo "io.github.Foo/mcp@raro!" pasaba tal
  // cual), y claves como __proto__ ni siquiera se guardan como propiedad.
  name = nombreDeServidor(name);
  return mutate(userDataDir, (cj) => {
    cj.mcpServers = cj.mcpServers || {};
    const d = {};
    if (def.type && def.type !== 'stdio') d.type = def.type;
    if (def.url) d.url = def.url;
    else if (def.command) d.command = def.command;
    if (def.args && def.args.length) d.args = def.args;
    if (def.env && Object.keys(def.env).length) d.env = def.env;
    cj.mcpServers[String(name).trim()] = d;
    return { name, def: d };
  });
}

function removeUserMcp(userDataDir, name) {
  return mutate(userDataDir, (cj) => {
    if (cj.mcpServers) delete cj.mcpServers[name];
    return { name };
  });
}

function renameUserMcp(userDataDir, viejo, nuevo) {
  if (!nuevo || !String(nuevo).trim()) throw new Error('Falta el nombre nuevo.');
  return mutate(userDataDir, (cj) => {
    cj.mcpServers = cj.mcpServers || {};
    if (!cj.mcpServers[viejo]) throw new Error('No existe ese servidor.');
    cj.mcpServers[String(nuevo).trim()] = cj.mcpServers[viejo];
    delete cj.mcpServers[viejo];
    return { viejo, nuevo };
  });
}

module.exports = {
  nombreDeServidor,
  list, setTrust, setAllowedTools, setProjectMcp, mergeDuplicates, removeProject,
  setUserMcp, removeUserMcp, renameUserMcp,
};
