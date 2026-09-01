'use strict';
const path = require('path');
const os = require('os');
const { P, readJSON } = require('./sources/paths.cjs');

// Contencion de rutas.
//
// Todo lo que llega del renderer o de un archivo importado es entrada no
// confiable, incluso cuando el usuario es el dueño de la maquina: un paquete
// que le pasaron puede traer "../../.." en el nombre de una skill, y el
// renderer podria llamar cualquier handler con cualquier ruta.
//
// `path.resolve(x).startsWith(base)` NO alcanza: "C:/a/skills-malicioso"
// empieza con "C:/a/skills". Hay que comparar con el separador puesto.

function dentroDe(base, candidato) {
  if (!base || !candidato) return false;
  const b = path.resolve(base);
  const c = path.resolve(candidato);
  if (c === b) return true;
  const rel = path.relative(b, c);
  // Si para llegar hay que subir, o la relativa es absoluta, esta afuera.
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Un segmento de nombre que venga de afuera: sin separadores, sin "..",
// sin unidad de disco y sin caracteres invalidos en Windows.
function segmentoSeguro(nombre) {
  const s = String(nombre == null ? '' : nombre).trim();
  if (!s || s === '.' || s === '..') return null;
  if (/[\\/]/.test(s)) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) return null;
  return s;
}

// Una ruta relativa multi-segmento (como las claves de archivos de un paquete).
// Devuelve la ruta normalizada o null si intenta escapar.
function relativaSegura(rel) {
  const partes = String(rel == null ? '' : rel).split(/[\\/]+/).filter(Boolean);
  if (!partes.length) return null;
  const limpias = [];
  for (const p of partes) {
    const s = segmentoSeguro(p);
    if (!s) return null;
    limpias.push(s);
  }
  return limpias.join(path.sep);
}

// Une base + relativa verificando que el resultado no se escape. Es la funcion
// que hay que usar antes de escribir cualquier archivo cuyo nombre venga de
// afuera.
function unirSeguro(base, ...partes) {
  const rel = relativaSegura(partes.filter(Boolean).join('/'));
  if (!rel) return null;
  const destino = path.join(base, rel);
  return dentroDe(base, destino) ? destino : null;
}

// --- raices permitidas -------------------------------------------------------

// Carpetas que la app puede abrir o revelar en el explorador. Cualquier otra
// ruta se rechaza: no hay motivo para que la app abra C:\Windows\System32.
function raicesPermitidas(extra) {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const raices = [P.CLAUDE_DIR, path.dirname(P.CLAUDE_JSON), os.tmpdir()];
  for (const p of Object.keys(cj.projects || {})) {
    try { raices.push(path.resolve(p)); } catch { /* ruta rara */ }
  }
  for (const e of extra || []) if (e) raices.push(path.resolve(e));
  return raices;
}

function rutaPermitida(candidato, extra) {
  if (!candidato) return false;
  return raicesPermitidas(extra).some((r) => dentroDe(r, candidato));
}

// Raices donde puede vivir una skill editable.
function raicesDeSkills() {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const raices = [P.skills, path.join(P.plugins, 'marketplaces')];
  for (const p of Object.keys(cj.projects || {})) {
    try {
      const root = path.resolve(p);
      raices.push(path.join(root, '.claude', 'skills'));
      raices.push(path.join(root, '.agents', 'skills'));
    } catch { /* ruta rara */ }
  }
  return raices;
}

// Esquemas que se pueden abrir con el navegador. file:// queda afuera a
// proposito: abriria cualquier cosa del disco, y para eso esta openPath, que
// valida la ruta.
const ESQUEMAS = new Set(['http:', 'https:', 'mailto:']);

function urlPermitida(u) {
  try {
    return ESQUEMAS.has(new URL(String(u)).protocol);
  } catch {
    return false;
  }
}

// Repositorios git aceptables para clonar un marketplace. git soporta
// transportes como `ext::<comando>` que ejecutan un programa arbitrario: es un
// vector de ejecucion de codigo conocido y hay que excluirlo explicitamente.
function repoGitPermitido(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (/^(ext|fd|file|ftp|ftps|rsync)::?/i.test(s)) return false;
  if (/^-/.test(s)) return false; // no se cuela como flag de git
  if (/^https:\/\/[\w.-]+\/[\w.\-/]+$/.test(s)) return true;
  if (/^git@[\w.-]+:[\w.\-/]+$/.test(s)) return true;
  return false;
}

// dentroDe() usa path.resolve, que NO sigue symlinks: un enlace dentro de
// ~/.claude/hooks que apunte afuera pasaba el control y writeFileSync escribia
// del otro lado. Antes de escribir hay que resolver el destino real.
function destinoRealSeguro(base, file) {
  const fs = require('fs');
  if (!seguroBasico(base, file)) return null;
  try {
    // Si el archivo existe, se resuelve el; si no, su directorio.
    const existe = fs.existsSync(file);
    const real = fs.realpathSync(existe ? file : path.dirname(file));
    const comparar = existe ? real : path.join(real, path.basename(file));
    const baseReal = fs.existsSync(base) ? fs.realpathSync(base) : base;
    return dentroDe(baseReal, comparar) ? file : null;
  } catch {
    return null;   // no se pudo resolver: no se escribe
  }
}

function seguroBasico(base, file) {
  return !!file && dentroDe(base, file);
}

module.exports = {
  dentroDe, segmentoSeguro, relativaSegura, unirSeguro, destinoRealSeguro,
  rutaPermitida, raicesPermitidas, raicesDeSkills,
  urlPermitida, repoGitPermitido,
};
