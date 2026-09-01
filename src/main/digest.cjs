'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P, readJSON, listDir, statSafe } = require('./sources/paths.cjs');

// Digest: el resumen portable de una maquina, pensado para sincronizar entre
// tu escritorio y tu notebook sin mover los 287 MB de transcripts.
//
// Que SI viaja: contadores, tokens, costos, timestamps, nombres de proyecto,
// titulos de sesion y el objetivo que resumio Claude.
// Que NUNCA viaja: el cuerpo de los mensajes. Ni prompts, ni respuestas, ni
// resultados de herramientas. Con `redact: true` tampoco viajan titulos ni
// rutas (se reemplazan por un hash estable), para poder compartirlo con
// alguien mas sin filtrar en que estabas trabajando.

const SCHEMA_VERSION = 1;
const FILE_PREFIX = 'digest-';

// Formato columnar: 7000+ requests como objetos serian varios MB de nombres de
// campo repetidos. Como arrays con las columnas declaradas arriba, ~500 KB.
const REQUEST_COLUMNS = [
  'ts', 'model', 'session', 'input', 'output', 'thinking',
  'cacheRead', 'cacheWrite', 'cost', 'costNoCache', 'agent',
];

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function identity() {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const a = cj.oauthAccount || {};
  return {
    machineId: cj.machineID ? shortHash(cj.machineID) : shortHash(require('os').hostname()),
    // Sirve para no mezclar por accidente digests de dos cuentas distintas.
    // Es un hash: no identifica a nadie por si solo.
    accountId: a.accountUuid ? shortHash(a.accountUuid) : (cj.userID ? shortHash(cj.userID) : null),
  };
}

function redactText(s) {
  if (!s) return null;
  return 'oculto:' + shortHash(s).slice(0, 8);
}

function build(snapshot, summaries, opts) {
  const o = opts || {};
  const redact = !!o.redact;
  const id = identity();

  const models = [];
  const sessionIds = [];
  const modelIdx = new Map();
  const sessionIdx = new Map();
  const indexOf = (arr, map, v) => {
    const key = v == null ? '' : String(v);
    if (!map.has(key)) { map.set(key, arr.length); arr.push(key); }
    return map.get(key);
  };

  const requests = [];
  for (const s of summaries) {
    const owner = s.parentSessionId || s.sessionId;
    for (const r of s.requests) {
      requests.push([
        Date.parse(r.ts) || 0,
        indexOf(models, modelIdx, r.model),
        indexOf(sessionIds, sessionIdx, owner),
        r.input, r.output, r.thinking, r.cacheRead,
        Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h),
        Math.round(r.costUSD * 1e6) / 1e6,
        Math.round((r.costNoCacheUSD || 0) * 1e6) / 1e6,
        s.kind === 'session' ? 0 : 1,
      ]);
    }
  }

  const sessions = snapshot.sessions.map((s) => ({
    sessionId: s.sessionId,
    projectKey: redact ? shortHash(s.projectKey) : s.projectKey,
    cwd: redact ? redactText(s.cwd) : s.cwd,
    title: redact ? redactText(s.title) : s.title,
    gitBranch: redact ? null : s.gitBranch,
    version: s.version,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    userTurns: s.userTurns,
    // Solo timestamps, sin una sola palabra de lo que escribiste.
    userTurnTimes: s.userTurnTimes || [],
    toolCounts: s.toolCounts,
    totals: s.totals,
    own: s.own,
    agents: s.agents,
    sizeBytes: s.sizeBytes,
    meta: s.meta ? {
      durationMinutes: s.meta.durationMinutes,
      linesAdded: s.meta.linesAdded,
      linesRemoved: s.meta.linesRemoved,
      filesModified: s.meta.filesModified,
      interruptions: s.meta.interruptions,
      toolErrors: s.meta.toolErrors,
      languages: s.meta.languages,
    } : null,
    facets: s.facets && !redact ? {
      underlyingGoal: s.facets.underlyingGoal,
      outcome: s.facets.outcome,
      helpfulness: s.facets.helpfulness,
      sessionType: s.facets.sessionType,
      friction: s.facets.friction,
    } : (s.facets ? { outcome: s.facets.outcome, helpfulness: s.facets.helpfulness } : null),
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: id.machineId,
    machineLabel: o.machineLabel || require('os').hostname(),
    accountId: id.accountId,
    redacted: redact,
    generatedAt: new Date().toISOString(),
    appVersion: o.appVersion || null,
    counts: {
      sessions: sessions.length,
      requests: requests.length,
      transcriptBytes: snapshot.counts.diskBytes,
    },
    models,
    sessionIds,
    requestColumns: REQUEST_COLUMNS,
    requests,
    sessions,
  };
}

// --- lectura ---------------------------------------------------------------

function decodeRequests(digest) {
  const cols = digest.requestColumns || REQUEST_COLUMNS;
  const at = {};
  cols.forEach((c, i) => { at[c] = i; });
  const out = [];
  for (const row of digest.requests || []) {
    const cacheWrite = row[at.cacheWrite] || 0;
    out.push({
      ts: new Date(row[at.ts]).toISOString(),
      model: digest.models[row[at.model]] || null,
      sessionId: digest.sessionIds[row[at.session]] || null,
      input: row[at.input] || 0,
      output: row[at.output] || 0,
      thinking: row[at.thinking] || 0,
      cacheRead: row[at.cacheRead] || 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteTotal: cacheWrite,
      costUSD: row[at.cost] || 0,
      costNoCacheUSD: row[at.costNoCache] || 0,
      webSearches: 0,
      webFetches: 0,
      isSidechain: !!row[at.agent],
      from: row[at.agent] ? 'subagent' : 'session',
      machineId: digest.machineId,
      machineLabel: digest.machineLabel,
    });
  }
  return out;
}

function fileNameFor(machineId) {
  return FILE_PREFIX + machineId + '.json';
}

function write(dir, digest) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileNameFor(digest.machineId));
  // Escritura atomica: si la carpeta la esta sincronizando OneDrive/Syncthing,
  // un archivo a medio escribir se replicaria roto.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(digest));
  fs.renameSync(tmp, file);
  return file;
}

// Lee los digests de OTRAS maquinas. El propio se ignora: para la maquina
// local siempre manda el store en vivo, que esta mas fresco que el archivo.
function readOthers(dir, ownMachineId, ownAccountId) {
  const out = [];
  if (!dir || !statSafe(dir)) return out;
  for (const f of listDir(dir)) {
    if (!f.isFile() || !f.name.startsWith(FILE_PREFIX) || !f.name.endsWith('.json')) continue;
    const full = path.join(dir, f.name);
    const d = readJSON(full, null);
    if (!d || d.schemaVersion !== SCHEMA_VERSION) {
      out.push({ file: full, error: d ? 'schema v' + d.schemaVersion + ' incompatible' : 'ilegible' });
      continue;
    }
    if (d.machineId === ownMachineId) continue;
    if (ownAccountId && d.accountId && d.accountId !== ownAccountId) {
      out.push({ file: full, error: 'es de otra cuenta de Claude', machineLabel: d.machineLabel });
      continue;
    }
    const st = statSafe(full);
    out.push({ file: full, digest: d, mtimeMs: st ? st.mtimeMs : 0 });
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION, REQUEST_COLUMNS,
  build, write, readOthers, decodeRequests, identity, fileNameFor, shortHash,
};
