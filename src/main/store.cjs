'use strict';
const fs = require('fs');
const path = require('path');
const transcripts = require('./sources/transcripts.cjs');
const usageData = require('./sources/usageData.cjs');
const configSrc = require('./sources/config.cjs');
const memorySrc = require('./sources/memory.cjs');
const pricing = require('./sources/pricing.cjs');
const digest = require('./digest.cjs');
const seguro = require('./safePaths.cjs');
const { P, statSafe } = require('./sources/paths.cjs');

// Subir esto invalida la cache en disco: hacerlo cada vez que cambia
// la forma del resumen (titulos, campos de costo, etc.).
const CACHE_VERSION = 6;

class Store {
  constructor(cacheDir, settings) {
    this.cacheDir = cacheDir;
    this.cacheFile = path.join(cacheDir, 'sessions.json');
    this.summaries = new Map(); // file -> summary (esta maquina)
    this.remote = [];           // digests de las otras maquinas
    this.remoteErrors = [];
    this.settings = settings || { get: () => ({}) };
    this.identity = digest.identity();
    this.snapshot = null;
    this.building = null;
    this.lastBuiltAt = null;
    this._loadCache();
  }

  machineLabel() {
    return this.settings.get().machineLabel || require('os').hostname();
  }

  // Relee los digests de las otras maquinas desde la carpeta compartida.
  loadRemote() {
    const cfg = this.settings.get();
    this.remote = [];
    this.remoteErrors = [];
    if (!cfg.syncDir) return;
    for (const r of digest.readOthers(cfg.syncDir, this.identity.machineId, this.identity.accountId)) {
      if (r.error) this.remoteErrors.push({ file: r.file, error: r.error, machineLabel: r.machineLabel || null });
      else this.remote.push(r);
    }
  }

  // Publica el digest de ESTA maquina en la carpeta compartida.
  publishDigest() {
    const cfg = this.settings.get();
    if (!cfg.syncDir || !this.snapshot) return null;
    const d = digest.build(this.snapshot, [...this.summaries.values()], {
      redact: cfg.redact,
      machineLabel: this.machineLabel(),
      appVersion: '1.0.0',
    });
    return digest.write(cfg.syncDir, d);
  }

  _loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c.version !== CACHE_VERSION) return;
      for (const s of c.summaries) this.summaries.set(s.file, s);
    } catch { /* cache vacia o corrupta: se reconstruye */ }
  }

  _saveCache() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ version: CACHE_VERSION, summaries: [...this.summaries.values()] })
      );
    } catch { /* si no se puede escribir, seguimos en memoria */ }
  }

  // Reindexa solo los archivos cuyo mtime/size cambio.
  async refresh(onProgress) {
    if (this.building) return this.building;
    this.building = (async () => {
      const files = transcripts.listTranscriptFiles();
      const live = new Set(files.map((f) => f.file));
      let podados = 0;
      for (const key of [...this.summaries.keys()]) {
        if (!live.has(key)) { this.summaries.delete(key); podados++; }
      }
      let done = 0;
      let reparsed = 0;
      for (const entry of files) {
        const cached = this.summaries.get(entry.file);
        if (!cached || cached.mtimeMs !== entry.mtimeMs || cached.size !== entry.size) {
          // Se le pasa el resumen viejo: si el archivo solo crecio por el final,
          // summarize retoma desde ahi en vez de releer todo (un transcript de
          // 56 MB tardaba ~250 ms por cada linea nueva).
          this.summaries.set(entry.file, await transcripts.summarize(entry, cached));
          reparsed++;
        }
        done++;
        if (onProgress && done % 20 === 0) onProgress({ done, total: files.length });
      }
      // Tambien hay que bajar la poda al disco: si solo se borraron entradas
      // muertas y no se reparseo nada, la cache en memoria quedaba limpia pero
      // la del disco seguia inflada, y el proximo arranque la volvia a leer.
      if (reparsed || podados) this._saveCache();
      this.loadRemote();
      this.snapshot = this._build();
      this.lastBuiltAt = Date.now();
      let published = null;
      if (this.settings.get().autoPublish) {
        try { published = this.publishDigest(); }
        catch (e) { this.remoteErrors.push({ error: 'no se pudo publicar: ' + e.message }); }
      }
      return { files: files.length, reparsed, remotes: this.remote.length, published };
    })();
    try { return await this.building; } finally { this.building = null; }
  }

  _build() {
    const localLabel = this.machineLabel();
    const all = [...this.summaries.values()];

    // Los costos se recalculan ACA, no al indexar: los tokens ya estan en la
    // cache y lo unico que cambia al editar precios es la tarifa. Asi cambiar
    // la tabla de precios es instantaneo en vez de reparsear 128 transcripts.
    const reqsDe = new Map();
    for (const s of all) {
      reqsDe.set(s.file, s.requests.map((r) => Object.assign({}, r, {
        costUSD: pricing.costOfRow(r),
        costNoCacheUSD: pricing.costNoCacheOfRow(r),
      })));
    }
    const totalesDe = (s) => transcripts.totalsOf(reqsDe.get(s.file) || []);
    const sessions = all.filter((s) => s.kind === 'session');
    const children = all.filter((s) => s.kind !== 'session');

    const byParent = new Map();
    for (const c of children) {
      const k = c.parentSessionId || '(huerfano)';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(c);
    }

    const ud = usageData.readAll();

    const rows = sessions.map((s) => {
      const kids = byParent.get(s.sessionId) || [];
      const kidTotals = transcripts.totalsOf(kids.flatMap((k) => reqsDe.get(k.file) || []));
      const propios = totalesDe(s);
      const combined = mergeTotals(propios, kidTotals);
      const meta = ud.meta.get(s.sessionId) || null;
      const facets = ud.facets.get(s.sessionId) || null;
      return {
        sessionId: s.sessionId,
        file: s.file,
        projectDir: s.projectDir,
        machineId: this.identity.machineId,
        machineLabel: localLabel,
        isRemote: false,
        cwd: s.cwd || s.project,
        projectKey: projectKey(s.cwd || s.projectDir),
        gitBranch: s.gitBranch,
        version: s.version,
        title: s.title,
        firstPrompt: s.firstPrompt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        userTurns: s.userTurns,
        userTurnTimes: s.userTurnTimes || [],
        toolCounts: mergeCounts(s.toolCounts, ...kids.map((k) => k.toolCounts)),
        models: s.models,
        own: propios,
        agents: {
          count: kids.length,
          subagents: kids.filter((k) => k.kind === 'subagent').length,
          workflowAgents: kids.filter((k) => k.kind === 'workflow-agent').length,
          workflows: [...new Set(kids.map((k) => k.workflowId).filter(Boolean))],
          totals: kidTotals,
        },
        totals: combined,
        meta,
        facets,
        sizeBytes: s.size + kids.reduce((a, k) => a + k.size, 0),
      };
    });

    const requests = [];
    for (const s of all) {
      for (const r of reqsDe.get(s.file) || []) {
        requests.push(Object.assign({
          sessionId: s.parentSessionId || s.sessionId,
          from: s.kind,
          machineId: this.identity.machineId,
          machineLabel: localLabel,
        }, r));
      }
    }

    // --- otras maquinas -----------------------------------------------------
    const machines = [{
      id: this.identity.machineId,
      label: localLabel,
      isLocal: true,
      sessions: rows.length,
      requests: requests.length,
      transcriptBytes: all.reduce((a, s) => a + s.size, 0),
      generatedAt: new Date().toISOString(),
      redacted: false,
    }];

    for (const entry of this.remote) {
      const d = entry.digest;
      const remoteRequests = digest.decodeRequests(d);
      for (const r of remoteRequests) requests.push(r);
      for (const rs of d.sessions || []) {
        rows.push(Object.assign({}, rs, {
          file: null,
          projectDir: null,
          machineId: d.machineId,
          machineLabel: d.machineLabel,
          isRemote: true,
          models: {},
        }));
      }
      machines.push({
        id: d.machineId,
        label: d.machineLabel,
        isLocal: false,
        sessions: (d.sessions || []).length,
        requests: remoteRequests.length,
        transcriptBytes: (d.counts && d.counts.transcriptBytes) || 0,
        generatedAt: d.generatedAt,
        redacted: !!d.redacted,
        file: entry.file,
      });
    }

    rows.sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
    requests.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    const projectOf = new Map();
    for (const row of rows) projectOf.set(row.sessionId, { key: row.projectKey, project: row.cwd });
    // los subagentes heredan el proyecto de la sesion padre
    for (const c of children) {
      if (c.parentSessionId && projectOf.has(c.parentSessionId)) {
        projectOf.set(c.sessionId, projectOf.get(c.parentSessionId));
      }
    }

    const userTurnTimes = [];
    for (const row of rows) {
      for (const t of row.userTurnTimes || []) userTurnTimes.push(t);
    }

    const cfg = configSrc.readAll();

    return {
      builtAt: new Date().toISOString(),
      machines,
      remoteErrors: this.remoteErrors,
      syncDir: this.settings.get().syncDir || null,
      sessions: rows,
      periods: buildPeriods(requests, rows, userTurnTimes, projectOf),
      // Solo vale la pena calcular por maquina si hay mas de una.
      periodsByMachine: machines.length < 2 ? null : Object.fromEntries(
        machines.map((m) => {
          const reqs = requests.filter((r) => r.machineId === m.id);
          const rws = rows.filter((r) => r.machineId === m.id);
          const turns = [];
          for (const row of rws) for (const t of row.userTurnTimes || []) turns.push(t);
          return [m.id, buildPeriods(reqs, rws, turns, projectOf)];
        })
      ),
      daily: dailySeries(requests),
      byModel: groupBy(requests, (r) => r.model || 'unknown'),
      byProject: projectRollup(rows),
      byTool: toolRollup(rows),
      totals: transcripts.totalsOf(requests),
      counts: {
        sessions: rows.length,
        localSessions: sessions.length,
        subagentTranscripts: children.length,
        requests: requests.length,
        diskBytes: all.reduce((a, s) => a + s.size, 0),
      },
      config: cfg,
      reports: ud.reports,
      pricing: pricing.info(),
      pricingNote:
        'Costo = equivalente a tarifa API publica. Tu cuenta es por suscripcion, ' +
        'asi que sirve para comparar sesiones, no como factura. El limite real son los medidores 5h / 7d.',
    };
  }

  async getSnapshot() {
    if (!this.snapshot) await this.refresh();
    return this.snapshot;
  }

  // El proceso principal inyecta aca su generador de miniaturas (nativeImage).
  setThumbnailer(fn) { this.thumbnailer = fn; }

  async getSession(sessionId, opts) {
    const snap = await this.getSnapshot();
    const row = snap.sessions.find((s) => s.sessionId === sessionId);
    if (!row) return null;
    if (row.isRemote || !row.file) {
      // El digest trae los numeros, no las conversaciones: el transcript vive
      // en la otra maquina y a proposito nunca se sincroniza.
      return { session: row, messages: [], agents: [], remoteOnly: true };
    }
    const messages = await transcripts.loadThread(row.file,
      Object.assign({}, opts, { thumbnailer: this.thumbnailer }));
    const kids = [...this.summaries.values()]
      .filter((s) => s.parentSessionId === sessionId)
      .map((s) => ({
        sessionId: s.sessionId, kind: s.kind, workflowId: s.workflowId,
        file: s.file, title: s.title, totals: s.totals,
        startedAt: s.startedAt, endedAt: s.endedAt,
      }));
    return { session: row, messages, agents: kids };
  }

  // La ruta de un transcript de subagente llega desde el renderer. Aceptarla
  // tal cual dejaba leer cualquier archivo del disco: se exige que este bajo
  // ~/.claude/projects y que sea un .jsonl.
  _transcriptValido(file) {
    if (!file || !/\.jsonl$/i.test(String(file))) return null;
    if (!seguro.dentroDe(P.projects, file)) return null;
    return statSafe(file) ? file : null;
  }

  async getAgentThread(file, opts) {
    const f = this._transcriptValido(file);
    if (!f) throw new Error('Ese transcript no existe o está fuera de ~/.claude/projects.');
    return transcripts.loadThread(f, Object.assign({}, opts, { thumbnailer: this.thumbnailer }));
  }

  // Imagen completa de una sesion, a demanda.
  async getImage(sessionId, ref) {
    const snap = await this.getSnapshot();
    const row = snap.sessions.find((s) => s.sessionId === sessionId);
    if (!row || !row.file) return null;
    return transcripts.readImage(row.file, ref);
  }

  // Lo mismo para un hilo de subagente, que no tiene sessionId en el snapshot
  // y por eso se identifica por su archivo.
  async getAgentImage(file, ref) {
    const f = this._transcriptValido(file);
    if (!f) throw new Error('Ese transcript no existe o está fuera de ~/.claude/projects.');
    return transcripts.readImage(f, ref);
  }

  async search(query, opts) {
    const o = opts || {};
    if (!query || !query.trim()) return { hits: [], scanned: 0, truncated: false };
    const matcher = transcripts.makeMatcher(query, o);
    let entries = [...this.summaries.values()];
    if (o.project) entries = entries.filter((s) => projectKey(s.cwd || s.projectDir) === projectKey(o.project));
    if (!o.includeAgents) entries = entries.filter((s) => s.kind === 'session');
    if (o.since) entries = entries.filter((s) => !s.endedAt || s.endedAt >= o.since);
    entries.sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));

    const limit = o.limit || 200;
    const perFile = o.perFile || 12;
    const hits = [];
    let scanned = 0;
    for (const e of entries) {
      if (hits.length >= limit) return { hits, scanned, truncated: true };
      scanned++;
      const found = await transcripts.searchFile(e, matcher, perFile);
      for (const h of found) {
        hits.push(Object.assign({}, h, {
          title: e.title,
          cwd: e.cwd || e.projectDir,
          kind: e.kind,
          parentSessionId: e.parentSessionId,
          file: e.file,
        }));
      }
    }
    return { hits, scanned, truncated: false };
  }

  async getMemory() {
    const mem = await memorySrc.readAll();
    // El nombre de carpeta en projects/ es una codificacion con guiones que no
    // se puede decodificar sin ambiguedad; el cwd real esta en el transcript.
    const realPath = new Map();
    for (const s of this.summaries.values()) {
      if (s.cwd && !realPath.has(s.projectDir)) realPath.set(s.projectDir, s.cwd);
    }
    for (const store of mem.claudeMemory) {
      store.projectPath = realPath.get(store.projectDir) || store.projectPath || null;
    }
    return mem;
  }
}


// ---- buckets de tiempo (hora LOCAL, no UTC) --------------------------------

// Los timestamps del transcript son ISO en UTC. Agrupar por los primeros 10
// caracteres agrupa por dia UTC: en Argentina (UTC-3) todo lo que hacias
// despues de las 21:00 caia en el dia siguiente. Se agrupa por dia local.
function pad(n) { return n < 10 ? '0' + n : String(n); }

function localDayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function localHourKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return localDayKey(ts) + 'T' + pad(d.getHours());
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 86400000;


// ---- periodos (Hoy / 24 h / 7 dias / 30 dias / Todo) -----------------------

// Cada periodo se calcula aca y no en el renderer: el proceso principal ya
// tiene todos los requests deduplicados, y mandar 7000+ por IPC en cada cambio
// de boton seria un desperdicio.
function bucketKey(ts, granularity) {
  return granularity === 'hour' ? localHourKey(ts) : localDayKey(ts);
}

function emptyBucket(key) {
  return {
    date: key, requests: 0, input: 0, output: 0, thinking: 0,
    cacheRead: 0, cacheWrite: 0, costUSD: 0, models: {},
  };
}

function buildSeries(requests, granularity, fromMs, toMs) {
  const map = new Map();
  let minTs = Infinity;
  for (const r of requests) {
    const ms = Date.parse(r.ts);
    if (isNaN(ms)) continue;
    if (ms < minTs) minTs = ms;
    const key = bucketKey(r.ts, granularity);
    if (!key) continue;
    if (!map.has(key)) map.set(key, emptyBucket(key));
    const b = map.get(key);
    b.requests++;
    b.input += r.input;
    b.output += r.output;
    b.thinking += r.thinking;
    b.cacheRead += r.cacheRead;
    b.cacheWrite += Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    b.costUSD += r.costUSD;
    const label = pricing.labelFor(r.model);
    b.models[label] = (b.models[label] || 0) + r.costUSD;
  }
  if (!map.size) return [];

  // Rellena los huecos: sin esto el grafico une dos fechas lejanas con una
  // recta y parece que hubo consumo en el medio.
  const start = fromMs || minTs;
  const cur = new Date(start);
  if (granularity === 'hour') cur.setMinutes(0, 0, 0);
  else cur.setHours(0, 0, 0, 0);
  const end = toMs || Date.now();
  const step = granularity === 'hour' ? 3600000 : DAY_MS;
  const filled = [];
  let guard = 0;
  while (cur.getTime() <= end && guard++ < 5000) {
    const key = bucketKey(cur.getTime(), granularity);
    filled.push(map.get(key) || emptyBucket(key));
    if (granularity === 'hour') cur.setTime(cur.getTime() + step);
    else cur.setDate(cur.getDate() + 1);
  }
  return filled;
}

function projectRollupFromRequests(requests, projectOf) {
  const map = new Map();
  for (const r of requests) {
    const p = projectOf.get(r.sessionId);
    const key = p ? p.key : '(desconocido)';
    if (!map.has(key)) {
      map.set(key, {
        key, project: p ? p.project : '(desconocido)',
        sessions: 0, requests: 0, costUSD: 0, totalTokens: 0, userTurns: 0, lastActivity: null,
      });
    }
    const g = map.get(key);
    g.requests++;
    g.costUSD += r.costUSD;
    g.totalTokens += r.input + r.output + r.cacheRead +
      Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    if (!g.lastActivity || String(r.ts) > g.lastActivity) g.lastActivity = r.ts;
  }
  return [...map.values()].sort((a, b) => b.costUSD - a.costUSD);
}

function buildPeriods(requests, sessionRows, userTurnTimes, projectOf) {
  const now = Date.now();
  const defs = [
    { key: 'today', label: 'Hoy',      since: startOfLocalDay(now), granularity: 'hour' },
    { key: 'h24',   label: '24 h',     since: now - DAY_MS,         granularity: 'hour' },
    { key: 'd7',    label: '7 dias',   since: now - 7 * DAY_MS,     granularity: 'day' },
    { key: 'd14',   label: '14 dias',  since: now - 14 * DAY_MS,    granularity: 'day' },
    { key: 'd30',   label: '30 dias',  since: now - 30 * DAY_MS,    granularity: 'day' },
    { key: 'all',   label: 'Todo',     since: 0,                    granularity: 'day' },
  ];

  const out = {};
  for (const d of defs) {
    const inRange = (iso) => {
      if (!d.since) return true;
      const ms = Date.parse(iso);
      return !isNaN(ms) && ms >= d.since;
    };
    const reqs = d.since ? requests.filter((r) => inRange(r.ts)) : requests;
    const sess = sessionRows.filter((s) => s.endedAt && inRange(s.endedAt));
    const byProject = projectRollupFromRequests(reqs, projectOf);
    for (const p of byProject) {
      p.sessions = sess.filter((s) => s.projectKey === p.key).length;
    }
    out[d.key] = {
      key: d.key,
      label: d.label,
      since: d.since || null,
      granularity: d.granularity,
      totals: transcripts.totalsOf(reqs),
      userTurns: userTurnTimes.filter(inRange).length,
      sessions: sess.length,
      byModel: groupBy(reqs, (r) => r.model || 'unknown'),
      byProject,
      series: buildSeries(reqs, d.granularity, d.since || null, now),
    };
  }
  return out;
}

// ---- helpers de agregacion ------------------------------------------------

function mergeTotals(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[k] = ((a && a[k]) || 0) + ((b && b[k]) || 0);
  }
  return out;
}

function mergeCounts(...objs) {
  const out = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o || {})) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function dailySeries(requests) {
  const map = new Map();
  for (const r of requests) {
    if (!r.ts) continue;
    const day = localDayKey(r.ts);
    if (!day) continue;
    if (!map.has(day)) {
      map.set(day, {
        date: day, requests: 0, input: 0, output: 0, thinking: 0,
        cacheRead: 0, cacheWrite: 0, costUSD: 0, models: {},
      });
    }
    const d = map.get(day);
    d.requests++;
    d.input += r.input;
    d.output += r.output;
    d.thinking += r.thinking;
    d.cacheRead += r.cacheRead;
    d.cacheWrite += Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    d.costUSD += r.costUSD;
    const m = pricing.labelFor(r.model);
    d.models[m] = (d.models[m] || 0) + r.costUSD;
  }
  const rows = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return rows;
  // Rellena los dias sin actividad con ceros: si no, el grafico dibuja una
  // recta entre dos fechas lejanas y parece que hubo consumo cuando no lo hubo.
  const filled = [];
  const cur = new Date(rows[0].date + 'T00:00:00');
  const end = new Date(rows[rows.length - 1].date + 'T00:00:00');
  const byDate = new Map(rows.map((r) => [r.date, r]));
  while (cur <= end) {
    const key = localDayKey(cur.getTime());
    filled.push(byDate.get(key) || {
      date: key, requests: 0, input: 0, output: 0, thinking: 0,
      cacheRead: 0, cacheWrite: 0, costUSD: 0, models: {},
    });
    cur.setDate(cur.getDate() + 1);
  }
  return filled;
}

function groupBy(requests, keyFn) {
  const map = new Map();
  for (const r of requests) {
    const k = keyFn(r);
    if (!map.has(k)) {
      map.set(k, { key: k, label: pricing.labelFor(k), requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 });
    }
    const g = map.get(k);
    g.requests++;
    g.input += r.input;
    g.output += r.output;
    g.cacheRead += r.cacheRead;
    g.cacheWrite += Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    g.costUSD += r.costUSD;
  }
  return [...map.values()].sort((a, b) => b.costUSD - a.costUSD);
}

// En Windows el mismo repo aparece como "c:\..." y "C:\...": se agrupan igual.
function projectKey(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function projectRollup(rows) {
  const map = new Map();
  for (const s of rows) {
    const raw = s.cwd || s.projectDir;
    const k = projectKey(raw);
    if (!map.has(k)) {
      map.set(k, { key: k, project: raw, sessions: 0, requests: 0, costUSD: 0, totalTokens: 0, userTurns: 0, lastActivity: null });
    }
    const g = map.get(k);
    g.sessions++;
    g.requests += s.totals.requests || 0;
    g.costUSD += s.totals.costUSD || 0;
    g.totalTokens += s.totals.totalTokens || 0;
    g.userTurns += s.userTurns || 0;
    if (!g.lastActivity || String(s.endedAt) > g.lastActivity) g.lastActivity = s.endedAt;
  }
  return [...map.values()].sort((a, b) => b.costUSD - a.costUSD);
}

function toolRollup(rows) {
  const counts = mergeCounts(...rows.map((r) => r.toolCounts));
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

module.exports = { Store, projectKey };
