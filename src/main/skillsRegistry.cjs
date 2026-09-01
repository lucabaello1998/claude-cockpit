'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { P, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Buscador de skills contra skills.sh (The Agent Skills Directory).
//
// La API no esta documentada, pero /api/search devuelve JSON y es lo unico
// que responde: /api/skills, /registry.json y /api/trpc/* dan 404. Como no es
// un contrato publico, todo lo que dependa de su forma esta a la defensiva:
// si cambia, se avisa en vez de romper.
//
// La descripcion no viene en la busqueda: se trae del SKILL.md del repo en
// GitHub, que es la fuente real de todas formas.

const BUSQUEDA = 'https://www.skills.sh/api/search';
const RAW = 'https://raw.githubusercontent.com';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'claude-cockpit/1.0', Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('El directorio respondió ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('Respuesta no válida del directorio.')); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('El directorio tardó demasiado.')); });
    req.on('error', (e) => reject(new Error('No se pudo llegar al directorio: ' + e.message)));
  });
}

function getTexto(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'claude-cockpit/1.0' }, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function search(q) {
  const j = await getJson(`${BUSQUEDA}?q=${encodeURIComponent(q || '')}`);
  const lista = Array.isArray(j.skills) ? j.skills : [];
  if (!lista.length && !Array.isArray(j.skills)) {
    throw new Error('El directorio cambió de formato: no llegó una lista de skills.');
  }
  return {
    total: j.count || lista.length,
    skills: lista.map((s) => {
      const [owner, repo, ...resto] = String(s.id || '').split('/');
      return {
        id: s.id,
        name: s.skillId || s.name,
        source: s.source || (owner && repo ? `${owner}/${repo}` : null),
        // La ruta dentro del repo: lo que sobra despues de owner/repo.
        subPath: resto.join('/') || s.skillId || s.name,
        installs: s.installs || 0,
        owner: owner || null,
      };
    }),
  };
}

// Trae el SKILL.md desde GitHub probando las ramas y ubicaciones habituales.
async function detalle(skill) {
  if (!skill || !skill.source) return null;
  const candidatos = [];
  for (const rama of ['main', 'master']) {
    if (skill.subPath) candidatos.push(`${RAW}/${skill.source}/${rama}/${skill.subPath}/SKILL.md`);
    candidatos.push(`${RAW}/${skill.source}/${rama}/SKILL.md`);
    candidatos.push(`${RAW}/${skill.source}/${rama}/skills/${skill.name}/SKILL.md`);
  }
  for (const url of candidatos) {
    const txt = await getTexto(url);
    if (!txt) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(txt);
    const meta = {};
    if (fm) {
      for (const linea of fm[1].split(/\r?\n/)) {
        const kv = /^([\w-]+):\s*(.*)$/.exec(linea);
        if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return {
      url,
      raw: txt,
      description: meta.description || '',
      name: meta.name || skill.name,
      body: fm ? fm[2] : txt,
      bytes: Buffer.byteLength(txt),
    };
  }
  return null;
}

// Instala copiando el SKILL.md a ~/.claude/skills/<nombre>/.
// No se usa `npx skills add` a proposito: ese comando escribe donde quiere y
// sin confirmacion. Aca se escribe un solo archivo, en una ruta validada, y el
// usuario ya vio el contenido en pantalla antes de aceptar.
function instalar(nombre, contenido) {
  const limpio = seguro.segmentoSeguro(String(nombre || '').trim().replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!limpio) throw new Error('Nombre inválido.');
  const dir = seguro.unirSeguro(P.skills, limpio);
  if (!dir) throw new Error('Nombre inválido.');
  if (statSafe(dir)) throw new Error('Ya tenés una skill con ese nombre.');
  if (!String(contenido || '').trim()) throw new Error('El contenido está vacío.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), contenido);
  return { name: limpio, dir };
}

module.exports = { search, detalle, instalar, BUSQUEDA };
