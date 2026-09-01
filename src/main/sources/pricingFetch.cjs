'use strict';
const https = require('https');

// Trae los precios desde la documentacion oficial de Anthropic.
//
// Por que de ahi y no de una calculadora de terceros: NO existe un endpoint de
// precios en JSON. Las calculadoras que hay online son el scrapeo que hizo otro
// de esta misma pagina; si esa persona se equivoca o no la actualiza, heredas
// su error y encima le creerias mas por venir "de internet".
//
// La doc sirve una version .md (43 KB, tabla markdown limpia) que es mucho mas
// estable de parsear que el HTML (729 KB, con los nombres repetidos en el menu).
// Aun asi NO es un contrato: si el formato cambia, esto devuelve error y la app
// sigue con la tabla que trae adentro. Nunca se aplica solo.

const URL_DOC = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'claude-cockpit/1.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('La documentación respondió ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('La consulta tardó demasiado.')); });
    req.on('error', (e) => reject(new Error('No se pudo llegar a la documentación: ' + e.message)));
  });
}

// "Claude Sonnet 4.6" -> "claude-sonnet-4-6"
function toModelId(label) {
  return String(label)
    .replace(/\[.*?\]\(.*?\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/\s+/g, '-');
}

const NUM = '\\$([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*MTok';
// | Modelo | input | write5m | write1h | read | output |
const FILA = new RegExp(
  '^\\|\\s*(Claude [^|]+?)\\s*\\|\\s*' + NUM + '\\s*\\|\\s*' + NUM +
  '\\s*\\|\\s*' + NUM + '\\s*\\|\\s*' + NUM + '\\s*\\|\\s*' + NUM + '\\s*\\|',
  'gm'
);

function parse(md) {
  const models = {};
  let n = 0;
  for (const m of md.matchAll(FILA)) {
    const label = m[1].replace(/\[.*?\]\(.*?\)/g, '').trim();
    const id = toModelId(label);
    if (!id.startsWith('claude-')) continue;
    models[id] = {
      label,
      input: Number(m[2]),
      write5m: Number(m[3]),
      write1h: Number(m[4]),
      read: Number(m[5]),
      output: Number(m[6]),
    };
    n++;
  }
  if (!n) throw new Error('No se encontró la tabla de precios: cambió el formato de la documentación.');

  // Fast mode: tabla aparte, de DOS columnas. El `\|\s*$` es lo que la
  // distingue de la tabla principal, cuya fila de Opus 5 empieza igual pero
  // sigue con cinco columnas.
  let fast = null;
  const mf = new RegExp(
    '^\\|[^|]*Opus 5[^|]*\\|\\s*' + NUM + '\\s*\\|\\s*' + NUM + '\\s*\\|\\s*$', 'm'
  ).exec(md);
  if (mf) fast = { input: Number(mf[1]), output: Number(mf[2]) };

  const ws = /\$([0-9.,]+)\s*per\s*1,?000\s*searches/i.exec(md);
  const webSearchPer1000 = ws ? Number(String(ws[1]).replace(/,/g, '')) : null;

  return { models, fast, webSearchPer1000 };
}

async function fetchPricing() {
  const md = await get(URL_DOC);
  const parsed = parse(md);
  return Object.assign({
    fetchedAt: new Date().toISOString(),
    source: URL_DOC,
    count: Object.keys(parsed.models).length,
  }, parsed);
}

module.exports = { fetchPricing, parse, toModelId, URL_DOC };
