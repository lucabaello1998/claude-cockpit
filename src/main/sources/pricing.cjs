'use strict';

// Tarifas por millon de tokens, en USD.
//
// IMPORTANTE: esto es SIEMPRE una estimacion.
//   - la cuenta de Claude Code es por suscripcion, no se factura por token;
//     el numero sirve para comparar sesiones entre si, no como factura
//   - los precios cambian y no hay ningun endpoint oficial en JSON para
//     consultarlos: esta tabla es una foto con fecha
//   - en Bedrock, Vertex o con descuentos negociados las tarifas son otras
// Por eso la app permite reemplazarla (bajada de la doc oficial o a mano) y
// tambien apagar los precios y mirar solo tokens, que son exactos.

const TABLA_INCLUIDA_AL = '2026-08-30';

// input / output / write5m / write1h / read, por millon de tokens.
const MODELS = {
  'claude-fable-5':    { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1,    label: 'Fable 5',    family: 'fable' },
  'claude-mythos-5':   { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1,    label: 'Mythos 5',   family: 'fable' },
  'claude-opus-5':     { input: 5,  output: 25, write5m: 6.25, write1h: 10, read: 0.5,  label: 'Opus 5',     family: 'opus' },
  'claude-opus-4-8':   { input: 5,  output: 25, write5m: 6.25, write1h: 10, read: 0.5,  label: 'Opus 4.8',   family: 'opus' },
  'claude-opus-4-7':   { input: 5,  output: 25, write5m: 6.25, write1h: 10, read: 0.5,  label: 'Opus 4.7',   family: 'opus' },
  'claude-opus-4-6':   { input: 5,  output: 25, write5m: 6.25, write1h: 10, read: 0.5,  label: 'Opus 4.6',   family: 'opus' },
  'claude-opus-4-5':   { input: 5,  output: 25, write5m: 6.25, write1h: 10, read: 0.5,  label: 'Opus 4.5',   family: 'opus' },
  'claude-sonnet-5':   { input: 2,  output: 10, write5m: 2.5,  write1h: 4,  read: 0.2,  label: 'Sonnet 5',   family: 'sonnet' },
  'claude-sonnet-4-6': { input: 3,  output: 15, write5m: 3.75, write1h: 6,  read: 0.3,  label: 'Sonnet 4.6', family: 'sonnet' },
  'claude-sonnet-4-5': { input: 3,  output: 15, write5m: 3.75, write1h: 6,  read: 0.3,  label: 'Sonnet 4.5', family: 'sonnet' },
  'claude-haiku-4-5':  { input: 1,  output: 5,  write5m: 1.25, write1h: 2,  read: 0.1,  label: 'Haiku 4.5',  family: 'haiku' },
  'claude-haiku-3-5':  { input: 0.8, output: 4, write5m: 1,    write1h: 1.6, read: 0.08, label: 'Haiku 3.5', family: 'haiku' },
};

const FAST = { input: 10, output: 50 };        // Opus 5 / 4.8 en modo rapido
const WEB_SEARCH_PER_1000 = 10;                 // busquedas web del servidor
const UNKNOWN = { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5, label: 'desconocido', family: 'unknown' };

// --- tabla activa (puede venir reemplazada por el usuario) ------------------

let activa = {
  models: MODELS,
  fast: FAST,
  webSearchPer1000: WEB_SEARCH_PER_1000,
  source: 'incluida',
  fetchedAt: TABLA_INCLUIDA_AL,
};

let cacheResolver = new Map();

// La tabla que se aplique tiene que traer al menos input y output por modelo;
// lo que falte se completa con la incluida para no dejar huecos en cero.
function setTable(t) {
  if (!t || !t.models || !Object.keys(t.models).length) {
    activa = { models: MODELS, fast: FAST, webSearchPer1000: WEB_SEARCH_PER_1000, source: 'incluida', fetchedAt: TABLA_INCLUIDA_AL };
  } else {
    const models = {};
    for (const [id, m] of Object.entries(t.models)) {
      const base = MODELS[id] || UNKNOWN;
      models[id] = {
        label: m.label || base.label || id,
        family: base.family || 'unknown',
        input: num(m.input, base.input),
        output: num(m.output, base.output),
        write5m: num(m.write5m, num(m.input, base.input) * 1.25),
        write1h: num(m.write1h, num(m.input, base.input) * 2),
        read: num(m.read, num(m.input, base.input) * 0.1),
      };
    }
    activa = {
      models,
      fast: t.fast || FAST,
      webSearchPer1000: num(t.webSearchPer1000, WEB_SEARCH_PER_1000),
      source: t.source || 'personalizada',
      fetchedAt: t.fetchedAt || null,
    };
  }
  cacheResolver = new Map();
  return info();
}

function num(v, alt) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : alt;
}

function info() {
  return {
    source: activa.source,
    fetchedAt: activa.fetchedAt,
    bundledAt: TABLA_INCLUIDA_AL,
    count: Object.keys(activa.models).length,
    webSearchPer1000: activa.webSearchPer1000,
    models: activa.models,
  };
}

// --- resolucion de modelo ---------------------------------------------------

function resolveModel(id) {
  if (!id) return UNKNOWN;
  if (cacheResolver.has(id)) return cacheResolver.get(id);
  const T = activa.models;
  let hit = T[id];
  if (!hit) {
    const norm = String(id).replace(/\[.*?\]/g, '').replace(/-\d{8}$/, '');
    hit = T[norm];
  }
  if (!hit) {
    const s = String(id).toLowerCase();
    const key = Object.keys(T).find((k) => s.startsWith(k));
    if (key) hit = T[key];
  }
  if (!hit) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) hit = T['claude-fable-5'];
    else if (s.includes('opus')) hit = T['claude-opus-5'];
    else if (s.includes('sonnet')) hit = T['claude-sonnet-5'];
    else if (s.includes('haiku')) hit = T['claude-haiku-4-5'];
  }
  const out = hit || Object.assign({}, UNKNOWN, { label: String(id) });
  cacheResolver.set(id, out);
  return out;
}

function labelFor(id) { return resolveModel(id).label; }

// --- costo ------------------------------------------------------------------

function partes(u) {
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens || 0;
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  // Si no vino el desglose, el total se trata como escritura de 5 minutos.
  const wFallback = (w5 + w1) === 0 ? (u.cache_creation_input_tokens || 0) : 0;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    read: u.cache_read_input_tokens || 0,
    w5: w5 + wFallback,
    w1,
    searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
  };
}

function costOf(modelId, u, speed) {
  // Filas sinteticas del harness (errores, mensajes locales): no cuestan nada.
  if (!modelId || modelId === '<synthetic>') return 0;
  const m = resolveModel(modelId);
  const rapido = speed === 'fast' && m.family === 'opus';
  const p = partes(u);
  const inRate = rapido ? activa.fast.input : m.input;
  const outRate = rapido ? activa.fast.output : m.output;
  // En fast mode los multiplicadores de cache se aplican sobre la tarifa fast.
  const readRate = rapido ? inRate * 0.1 : m.read;
  const w5Rate = rapido ? inRate * 1.25 : m.write5m;
  const w1Rate = rapido ? inRate * 2 : m.write1h;

  return (
    (p.input * inRate + p.output * outRate + p.read * readRate + p.w5 * w5Rate + p.w1 * w1Rate) / 1e6
    + (p.searches * activa.webSearchPer1000) / 1000
  );
}

// Lo que habria costado el mismo trafico sin prompt caching.
function costWithoutCache(modelId, u, speed) {
  if (!modelId || modelId === '<synthetic>') return 0;
  const m = resolveModel(modelId);
  const rapido = speed === 'fast' && m.family === 'opus';
  const p = partes(u);
  const inRate = rapido ? activa.fast.input : m.input;
  const outRate = rapido ? activa.fast.output : m.output;
  const comoInput = p.input + p.read + p.w5 + p.w1;
  return (comoInput * inRate + p.output * outRate) / 1e6
    + (p.searches * activa.webSearchPer1000) / 1000;
}

// Igual que costOf pero a partir de una fila ya normalizada del indice, no del
// objeto `usage` crudo. Sirve para recalcular precios sin volver a parsear los
// transcripts: los tokens ya estan guardados, lo unico que cambia es la tarifa.
function comoUsage(r) {
  return {
    input_tokens: r.input || 0,
    output_tokens: r.output || 0,
    cache_read_input_tokens: r.cacheRead || 0,
    cache_creation_input_tokens: r.cacheWriteTotal || 0,
    cache_creation: {
      ephemeral_5m_input_tokens: r.cacheWrite5m || 0,
      ephemeral_1h_input_tokens: r.cacheWrite1h || 0,
    },
    server_tool_use: { web_search_requests: r.webSearches || 0 },
  };
}

function costOfRow(r) { return costOf(r.model, comoUsage(r), r.speed); }
function costNoCacheOfRow(r) { return costWithoutCache(r.model, comoUsage(r), r.speed); }

module.exports = {
  MODELS, FAST, TABLA_INCLUIDA_AL,
  costOfRow, costNoCacheOfRow,
  resolveModel, labelFor, costOf, costWithoutCache,
  setTable, info,
};
