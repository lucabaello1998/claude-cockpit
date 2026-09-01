'use strict';
const fs = require('fs');
const path = require('path');
const { P, readJSON, listDir, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Ninguna operacion acepta una ruta arbitraria: el directorio tiene que caer
// dentro de alguna raiz conocida de skills. Si no, se rechaza.
function exigirRaizDeSkills(dir) {
  if (!dir || !seguro.raicesDeSkills().some((r) => seguro.dentroDe(r, dir))) {
    throw new Error('Esa carpeta no es una skill conocida.');
  }
  return dir;
}

// Lectura y edicion de skills.
//
// Hay cuatro origenes y NO todos se pueden editar igual:
//   usuario   ~/.claude/skills/<n>/SKILL.md         -> editable, es tuyo
//   proyecto  <repo>/.claude|.agents/skills/...     -> editable, vive en el repo
//   plugin    marketplace clonado                   -> NO editar: se pisa al
//                                                      actualizar el marketplace.
//                                                      Se ofrece copiarlo a los tuyos.
//   integrada dentro del binario de Claude Code     -> no hay archivo que editar

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw || '');
  if (!m) return { meta: {}, body: raw || '', tenia: false };
  const meta = {};
  for (const linea of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*([\s\S]*)$/.exec(linea);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2], tenia: true };
}

// Si la descripcion trae dos puntos, comillas o saltos, YAML necesita comillas.
function yamlValor(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  return /[:#"'\[\]{}]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function serializar(meta, body) {
  const orden = ['name', 'description'];
  const claves = orden.filter((k) => meta[k] != null)
    .concat(Object.keys(meta).filter((k) => !orden.includes(k)));
  const fm = claves.map((k) => `${k}: ${yamlValor(meta[k])}`).join('\n');
  return `---\n${fm}\n---\n\n${String(body || '').replace(/^\n+/, '')}`;
}

function skillFile(dir) { return path.join(dir, 'SKILL.md'); }

function read(dir) {
  exigirRaizDeSkills(dir);
  const file = skillFile(dir);
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body, tenia } = parseFrontmatter(raw);
  return {
    dir,
    file,
    name: meta.name || path.basename(dir),
    description: meta.description || '',
    body,
    meta,
    sinFrontmatter: !tenia,
    bytes: Buffer.byteLength(raw),
  };
}

// Guarda cambios sobre un SKILL.md existente. Respeta cualquier otra clave del
// frontmatter que no toquemos (allowed-tools, model, etc.).
function save(dir, cambios) {
  exigirRaizDeSkills(dir);
  // Las de un marketplace no se editan: la proxima actualizacion las pisa.
  if (seguro.dentroDe(path.join(P.plugins, 'marketplaces'), dir)) {
    throw new Error('Esa skill viene de un marketplace: copiala a las tuyas para editarla.');
  }
  const file = skillFile(dir);
  if (!statSafe(file)) throw new Error('No existe ese SKILL.md');
  const actual = read(dir);
  const meta = Object.assign({}, actual.meta);
  if (cambios.name != null) meta.name = String(cambios.name).trim();
  if (cambios.description != null) meta.description = String(cambios.description).trim();
  const body = cambios.body != null ? cambios.body : actual.body;
  const previo = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.bak', previo);
  fs.writeFileSync(file, serializar(meta, body));
  return read(dir);
}

function crear(nombre, description, body) {
  const limpio = seguro.segmentoSeguro(String(nombre || '').trim().replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!limpio) throw new Error('Nombre inválido.');
  const dir = seguro.unirSeguro(P.skills, limpio);
  if (!dir) throw new Error('Nombre inválido.');
  if (statSafe(dir)) throw new Error('Ya existe una skill tuya con ese nombre.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    skillFile(dir),
    serializar({ name: limpio, description: description || '' }, body || '')
  );
  return read(dir);
}

function eliminar(dir) {
  // Solo dentro de ~/.claude/skills, y nunca la carpeta raiz.
  // startsWith() no alcanza: "~/.claude/skills-malicioso" empieza igual.
  if (!seguro.dentroDe(P.skills, dir) || path.resolve(dir) === path.resolve(P.skills)) {
    throw new Error('Solo se pueden borrar tus propias skills.');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { dir };
}

// Copia una skill de un plugin o de un proyecto a las tuyas, para poder
// editarla sin que la pise la proxima actualizacion del marketplace.
function copiarAMisSkills(origenDir, nombreNuevo) {
  const src = read(origenDir);
  const limpio = seguro.segmentoSeguro(String(nombreNuevo || src.name).trim().replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!limpio) throw new Error('Nombre inválido.');
  const dest = seguro.unirSeguro(P.skills, limpio);
  if (!dest) throw new Error('Nombre inválido.');
  if (statSafe(dest)) throw new Error('Ya tenés una skill con ese nombre.');
  fs.cpSync(origenDir, dest, { recursive: true });
  return read(dest);
}

// Lista los directorios de skills editables, con su origen.
function listar(cj) {
  const out = [];
  const agregar = (dir, scope, source) => {
    if (!statSafe(skillFile(dir))) return;
    try {
      const s = read(dir);
      out.push(Object.assign({ scope, source, editable: scope !== 'plugin' }, s));
    } catch { /* SKILL.md ilegible */ }
  };

  for (const d of listDir(P.skills)) {
    if (d.isDirectory()) agregar(path.join(P.skills, d.name), 'usuario', null);
  }

  const vistos = new Set();
  for (const p of Object.keys((cj && cj.projects) || {})) {
    const root = path.resolve(p);
    const k = root.toLowerCase();
    if (vistos.has(k) || !statSafe(root)) continue;
    vistos.add(k);
    for (const conv of ['.claude/skills', '.agents/skills']) {
      const base = path.join(root, ...conv.split('/'));
      for (const d of listDir(base)) {
        if (d.isDirectory()) agregar(path.join(base, d.name), 'proyecto', path.basename(root));
      }
    }
  }

  const mkBase = path.join(P.plugins, 'marketplaces');
  for (const mk of listDir(mkBase)) {
    if (!mk.isDirectory()) continue;
    const pluginsDir = path.join(mkBase, mk.name, 'plugins');
    for (const pl of listDir(pluginsDir)) {
      if (!pl.isDirectory()) continue;
      const base = path.join(pluginsDir, pl.name, 'skills');
      for (const d of listDir(base)) {
        if (d.isDirectory()) agregar(path.join(base, d.name), 'plugin', pl.name + '@' + mk.name);
      }
    }
  }

  return out;
}

module.exports = { read, save, crear, eliminar, copiarAMisSkills, listar, parseFrontmatter };
