'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { P, listDir, statSafe, prettifyProjectDir } = require('./paths.cjs');
const pricing = require('./pricing.cjs');

// --- descubrimiento de archivos -------------------------------------------

// Layout real en disco:
//   projects/<proj>/<sessionId>.jsonl                              <- sesion principal
//   projects/<proj>/<sessionId>/subagents/*.jsonl                  <- subagentes
//   projects/<proj>/<sessionId>/subagents/workflows/<wf>/*.jsonl   <- agentes de workflow
//   projects/<proj>/memory/*.md                                    <- memoria de Claude Code
// El gasto de los subagentes vive en SUS archivos, no en el principal:
// hay que sumarlos aparte o el costo de la sesion sale corto.
function listTranscriptFiles() {
  const out = [];
  for (const projDir of listDir(P.projects)) {
    if (!projDir.isDirectory()) continue;
    const dir = path.join(P.projects, projDir.name);
    for (const f of listDir(dir)) {
      const full = path.join(dir, f.name);
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        const st = statSafe(full);
        if (!st) continue;
        out.push({
          file: full,
          projectDir: projDir.name,
          sessionId: f.name.replace(/\.jsonl$/, ''),
          kind: 'session',
          parentSessionId: null,
          workflowId: null,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } else if (f.isDirectory() && f.name !== 'memory') {
        collectSubagents(path.join(full, 'subagents'), projDir.name, f.name, null, out);
      }
    }
  }
  return out;
}

function collectSubagents(dir, projectDir, parentSessionId, workflowId, out) {
  for (const f of listDir(dir)) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name === 'workflows') {
        for (const wf of listDir(full)) {
          if (wf.isDirectory()) {
            collectSubagents(path.join(full, wf.name), projectDir, parentSessionId, wf.name, out);
          }
        }
      } else {
        collectSubagents(full, projectDir, parentSessionId, workflowId, out);
      }
      continue;
    }
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const st = statSafe(full);
    if (!st) continue;
    out.push({
      file: full,
      projectDir,
      sessionId: f.name.replace(/\.jsonl$/, ''),
      kind: workflowId ? 'workflow-agent' : 'subagent',
      parentSessionId,
      workflowId,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
}

// --- helpers de contenido --------------------------------------------------

function blocksOf(message) {
  if (!message) return [];
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function textOf(message) {
  return blocksOf(message)
    .filter((b) => b && (b.type === 'text' || b.type === 'thinking'))
    .map((b) => b.text || b.thinking || '')
    .join('\n');
}

// El primer mensaje de una sesion suele venir envuelto en tags que inyecta el
// harness (<ide_opened_file>, <command-message>, <system-reminder>, ...).
// Sin sacarlos, el titulo de la sesion queda ilegible.
const HARNESS_TAGS = [
  'ide_opened_file', 'ide_selection', 'system-reminder',
  'command-message', 'command-name', 'command-args',
  'local-command-stdout', 'local-command-stderr',
  'user-prompt-submit-hook', 'session-start-hook', 'task-notification',
].join('|');

// Se arman con RegExp() a proposito: un literal con backreferences se rompe
// facil al editar el archivo con herramientas que reescapan backslashes.
const PAIRED = new RegExp('<(' + HARNESS_TAGS + ')(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>', 'g');
const LONE = new RegExp('<\\/?(?:' + HARNESS_TAGS + ')(?:\\s[^>]*)?>', 'g');

function cleanPrompt(text) {
  return String(text || '')
    .replace(PAIRED, ' ')
    .replace(LONE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Un turno de usuario puede ser algo que escribiste vos o algo que el harness
// inyecto como si lo fueras (el SKILL.md entero al cargar una skill, por
// ejemplo: 80.000 caracteres). El transcript los distingue:
//   escrito por vos -> origin: { kind: 'human' }, promptSource: 'sdk'
//   inyectado       -> sin origin ni promptSource
function isHumanTurn(row) {
  return !!(row.origin && row.origin.kind === 'human');
}

function injectedKind(text) {
  const t = String(text || '');
  if (/^Base directory for this skill:/i.test(t)) return 'skill';
  if (/^<command-(message|name)>/i.test(t)) return 'comando';
  if (/^Caveat: The messages below were generated/i.test(t)) return 'resumen';
  return 'harness';
}

function isRealUserTurn(row) {
  if (row.type !== 'user') return false;
  if (row.toolUseResult) return false;
  const blocks = blocksOf(row.message);
  if (!blocks.length) return false;
  return blocks.some((b) => b.type === 'text' && String(b.text || '').trim());
}

// --- resumen de una sesion (lo que se cachea) ------------------------------

// Lee las lineas de un archivo desde un offset, devolviendo cuantos bytes
// quedaron efectivamente consumidos (o sea, hasta el ultimo salto de linea).
// Una linea a medio escribir NO se despacha y sus bytes no se cuentan: se
// vuelven a leer en la proxima pasada.
function leerLineasDesde(file, desde, onLinea) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: desde });
    let resto = Buffer.alloc(0);
    let consumidos = 0;
    stream.on('data', (chunk) => {
      const buf = resto.length ? Buffer.concat([resto, chunk]) : chunk;
      let inicio = 0;
      let i;
      while ((i = buf.indexOf(10, inicio)) >= 0) {
        onLinea(buf.slice(inicio, i).toString('utf8'));
        inicio = i + 1;
      }
      consumidos += inicio;
      resto = inicio < buf.length ? Buffer.from(buf.slice(inicio)) : Buffer.alloc(0);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(desde + consumidos));
  });
}

// Huella del principio del archivo. Si cambia, el .jsonl no crecio por el
// final sino que lo reescribieron, y el reparseo incremental no vale.
const BYTES_DE_HUELLA = 65536;

function huellaDe(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(BYTES_DE_HUELLA);
    const leidos = fs.readSync(fd, buf, 0, BYTES_DE_HUELLA, 0);
    return require('crypto').createHash('sha1').update(buf.slice(0, leidos)).digest('hex');
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  }
}

// Un transcript de 56 MB se reparseaba entero cada vez que la sesion escribia
// una linea: ~250 ms cada 1.2 s mientras trabajas. Como el .jsonl solo crece
// por el final y todo lo que acumula summarize es "el primero gana", "el
// ultimo gana" o un contador, se puede retomar desde donde quedo.
//
// Solo se retoma si se cumple TODO: hay resumen previo con su offset, el
// archivo crecio, y la huella del principio no cambio. Ante cualquier duda se
// reparsea entero, que es lo que se hacia siempre.
function puedeRetomar(entry, previo) {
  if (!previo || typeof previo.parsedBytes !== 'number' || !previo.huella) return false;
  if (!Array.isArray(previo.requests)) return false;
  if (entry.size < previo.parsedBytes) return false;      // se achico: lo reescribieron
  if (entry.size === previo.parsedBytes) return false;    // nada nuevo que leer
  return huellaDe(entry.file) === previo.huella;
}

async function summarize(entry, previo) {
  const retoma = puedeRetomar(entry, previo);
  const s = retoma ? reanudar(entry, previo) : {
    sessionId: entry.sessionId,
    file: entry.file,
    projectDir: entry.projectDir,
    kind: entry.kind || 'session',
    parentSessionId: entry.parentSessionId || null,
    workflowId: entry.workflowId || null,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    cwd: null,
    project: prettifyProjectDir(entry.projectDir),
    gitBranch: null,
    version: null,
    entrypoint: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    startedAt: null,
    endedAt: null,
    userTurns: 0,
    userTurnTimes: [],
    assistantRows: 0,
    sidechainRows: 0,
    toolCounts: {},
    models: {},
    requests: [],
    totals: null,
    parseErrors: 0,
    parsedBytes: 0,
    huella: null,
  };

  // requestId -> request deduplicado. Al retomar se siembra con lo ya visto,
  // porque una fila nueva puede reescribir el usage de un requestId viejo.
  const seen = new Map();
  if (retoma) for (const r of previo.requests) seen.set(r.requestId, r);

  const desde = retoma ? previo.parsedBytes : 0;
  s.huella = retoma ? previo.huella : huellaDe(entry.file);
  s.mtimeMs = entry.mtimeMs;
  s.size = entry.size;

  s.parsedBytes = await leerLineasDesde(entry.file, desde, (line) => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { s.parseErrors++; return; }

    if (row.cwd && !s.cwd) s.cwd = row.cwd;
    if (row.gitBranch && !s.gitBranch) s.gitBranch = row.gitBranch;
    if (row.version) s.version = row.version;
    if (row.entrypoint && !s.entrypoint) s.entrypoint = row.entrypoint;
    if (row.timestamp) {
      if (!s.startedAt || row.timestamp < s.startedAt) s.startedAt = row.timestamp;
      if (!s.endedAt || row.timestamp > s.endedAt) s.endedAt = row.timestamp;
    }
    if (row.type === 'ai-title' && row.aiTitle) s.title = row.aiTitle;
    if (row.type === 'last-prompt' && row.lastPrompt) s.lastPrompt = row.lastPrompt;

    if (row.isSidechain) s.sidechainRows++;

    if (isRealUserTurn(row)) {
      // Solo cuentan los prompts que escribiste vos: si se cuenta la inyeccion
      // de una skill como consulta, el costo "por consulta tuya" queda mal.
      if (isHumanTurn(row)) s.userTurns++;
      if (row.timestamp && isHumanTurn(row)) s.userTurnTimes.push(row.timestamp);
      if (!s.firstPrompt && isHumanTurn(row)) {
        const raw = textOf(row.message);
        const clean = cleanPrompt(raw);
        if (clean) {
          s.firstPrompt = clean.slice(0, 400);
        } else {
          // sesion abierta con un slash command: el nombre es mejor titulo que nada
          const cmd = /<command-name>([^<]+)<\/command-name>/.exec(raw);
          if (cmd) s.firstPrompt = cmd[1].trim();
        }
      }
    }

    if (row.type === 'assistant') {
      s.assistantRows++;
      const m = row.message || {};
      for (const b of blocksOf(m)) {
        if (b.type === 'tool_use' && b.name) {
          s.toolCounts[b.name] = (s.toolCounts[b.name] || 0) + 1;
        }
      }
      const u = m.usage;
      if (u && row.requestId) {
        // El transcript reescribe la misma fila varias veces mientras streamea:
        // el mismo requestId aparece N veces con el usage acumulado.
        // Sin deduplicar por requestId el gasto sale inflado varias veces.
        seen.set(row.requestId, {
          requestId: row.requestId,
          ts: row.timestamp,
          model: m.model,
          effort: row.effort || null,
          speed: u.speed || null,
          serviceTier: u.service_tier || null,
          isSidechain: !!row.isSidechain,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite5m: (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0,
          cacheWrite1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
          cacheWriteTotal: u.cache_creation_input_tokens || 0,
          webSearches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
          webFetches: (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0,
          costUSD: pricing.costOf(m.model, u, u.speed),
          costNoCacheUSD: pricing.costWithoutCache(m.model, u, u.speed),
        });
      }
    }
  });

  s.requests = [...seen.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  s.totals = totalsOf(s.requests);
  s.models = {};   // se recalcula entero: al retomar traia los del tramo viejo
  for (const r of s.requests) {
    const k = r.model || 'unknown';
    if (!s.models[k]) s.models[k] = { requests: 0, tokens: 0, costUSD: 0 };
    s.models[k].requests++;
    s.models[k].tokens += r.input + r.output + r.cacheRead +
      Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    s.models[k].costUSD += r.costUSD;
  }
  if (!s.title) s.title = s.firstPrompt ? s.firstPrompt.slice(0, 80) : '(sin titulo)';
  return s;
}

// Estado desde el que se sigue contando. Se copia lo acumulativo y se deja en
// null lo que se recalcula al final (requests, totals, models).
function reanudar(entry, previo) {
  return {
    sessionId: entry.sessionId,
    file: entry.file,
    projectDir: entry.projectDir,
    kind: entry.kind || 'session',
    parentSessionId: entry.parentSessionId || null,
    workflowId: entry.workflowId || null,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    cwd: previo.cwd,
    project: prettifyProjectDir(entry.projectDir),
    gitBranch: previo.gitBranch,
    version: previo.version,
    entrypoint: previo.entrypoint,
    // El titulo derivado de firstPrompt se recalcula abajo; si vino de un
    // ai-title real hay que conservarlo, y eso solo se sabe comparando.
    title: (previo.title && previo.firstPrompt
      && previo.title === previo.firstPrompt.slice(0, 80)) ? null : previo.title,
    firstPrompt: previo.firstPrompt,
    lastPrompt: previo.lastPrompt,
    startedAt: previo.startedAt,
    endedAt: previo.endedAt,
    userTurns: previo.userTurns || 0,
    userTurnTimes: [...(previo.userTurnTimes || [])],
    assistantRows: previo.assistantRows || 0,
    sidechainRows: previo.sidechainRows || 0,
    toolCounts: Object.assign({}, previo.toolCounts),
    models: {},
    requests: [],
    totals: null,
    parseErrors: previo.parseErrors || 0,
    parsedBytes: previo.parsedBytes,
    huella: previo.huella,
  };
}

function totalsOf(requests) {
  const t = {
    requests: requests.length, input: 0, output: 0, thinking: 0,
    cacheRead: 0, cacheWrite: 0, costUSD: 0, costNoCacheUSD: 0,
    webSearches: 0, webFetches: 0, sidechainRequests: 0, agentCostUSD: 0,
  };
  for (const r of requests) {
    t.input += r.input;
    t.output += r.output;
    t.thinking += r.thinking;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += Math.max(r.cacheWriteTotal, r.cacheWrite5m + r.cacheWrite1h);
    t.costUSD += r.costUSD;
    t.costNoCacheUSD += r.costNoCacheUSD || 0;
    t.webSearches += r.webSearches;
    t.webFetches += r.webFetches;
    // `from` lo pone el store al mezclar (session / subagent / workflow-agent);
    // en un resumen suelto solo esta isSidechain.
    const isAgent = r.from ? r.from !== 'session' : r.isSidechain;
    if (isAgent) {
      t.sidechainRequests++;
      t.agentCostUSD += r.costUSD;
    }
  }
  t.totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

// --- hilo completo (se carga a demanda, no se cachea) ----------------------

const MAX_BLOCK = 12000;

// Una captura pegada en el chat es un base64 de cientos de KB. Hasta cierto
// tamano se manda tal cual para poder verla; pasado eso solo va la ficha,
// porque mandar 5 MB por IPC para pintar una miniatura no vale la pena.
const MAX_IMAGE_BYTES = 1500000;

// Las capturas pegadas en el chat son el 85% del peso de un hilo: una sesion
// con 95 imagenes mandaba 26 MB en un solo mensaje de IPC. Por defecto viaja
// una MINIATURA y la imagen completa se pide aparte al hacerle clic.
function imageBlock(b, thumbnailer, ref) {
  const src = b.source || {};
  const media = src.media_type || 'image/png';
  const data = typeof src.data === 'string' ? src.data : '';
  const bytes = Math.round((data.length * 3) / 4);

  if (src.type === 'url' && src.url) {
    return { type: 'image', url: src.url, media, bytes: 0, text: '', truncated: 0 };
  }
  if (!data) return { type: 'image', media, bytes: 0, vacia: true, text: '', truncated: 0 };

  const salida = { type: 'image', media, bytes, ref, text: '', truncated: 0 };
  if (thumbnailer) {
    salida.thumb = thumbnailer(data, media);
    salida.completaDisponible = true;
    return salida;
  }
  // Sin generador de miniaturas (por ejemplo corriendo fuera de Electron):
  // se manda entera solo si es chica, si no queda la ficha.
  if (data.length <= MAX_IMAGE_BYTES) salida.dataUri = `data:${media};base64,${data}`;
  else salida.tooBig = true;
  return salida;
}

// Convierte el contenido de un tool_result, que puede traer imagenes mezcladas.
function resultBlocks(content, thumbnailer, refBase) {
  if (typeof content === 'string') return null;
  if (!Array.isArray(content)) return null;
  const imgs = content.filter((c) => c && c.type === 'image');
  if (!imgs.length) return null;
  const rest = content.filter((c) => c && c.type !== 'image');
  return {
    images: imgs.map((im, k) => imageBlock(im, thumbnailer, { ...refBase, sub: k })),
    text: rest.map((c) => (c && c.type === 'text' ? c.text : JSON.stringify(c))).join('\n'),
  };
}

function clip(str) {
  const s = String(str == null ? '' : str);
  return s.length > MAX_BLOCK
    ? { text: s.slice(0, MAX_BLOCK), truncated: s.length - MAX_BLOCK }
    : { text: s, truncated: 0 };
}

async function loadThread(file, opts) {
  const o = opts || {};
  const includeSidechain = o.includeSidechain !== false;
  const thumbnailer = typeof o.thumbnailer === 'function' ? o.thumbnailer : null;
  const messages = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let i = 0;
  let fila = -1;
  for await (const line of rl) {
    fila++;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'user' && row.type !== 'assistant' && row.type !== 'attachment') continue;
    if (row.isSidechain && !includeSidechain) continue;

    if (row.type === 'attachment') {
      const a = row.attachment || {};
      const body = a.content || a.stdout || JSON.stringify(a).slice(0, 2000);
      messages.push({
        i: i++, role: 'system', ts: row.timestamp,
        isSidechain: !!row.isSidechain,
        label: a.hookName || a.type || 'attachment',
        blocks: [Object.assign({ type: 'text' }, clip(body))],
      });
      continue;
    }

    const m = row.message || {};
    const blocks = [];
    let idxBloque = -1;
    for (const b of blocksOf(m)) {
      idxBloque++;
      if (b.type === 'text') {
        // Los tags que inyecta el harness (<ide_opened_file>, <system-reminder>)
        // ensucian la lectura: se sacan, y si el bloque queda vacio se descarta.
        const limpio = row.type === 'user' ? cleanPrompt(b.text) : b.text;
        if (!String(limpio || '').trim()) continue;
        blocks.push(Object.assign({ type: 'text' }, clip(limpio)));
      }
      else if (b.type === 'thinking') blocks.push(Object.assign({ type: 'thinking' }, clip(b.thinking || b.text)));
      else if (b.type === 'tool_use') blocks.push(Object.assign({ type: 'tool_use', name: b.name, id: b.id }, clip(JSON.stringify(b.input, null, 2))));
      else if (b.type === 'image') blocks.push(imageBlock(b, thumbnailer, { fila, bloque: idxBloque }));
      else if (b.type === 'tool_result') {
        const mixed = resultBlocks(b.content, thumbnailer, { fila, bloque: idxBloque });
        if (mixed) {
          if (mixed.text.trim()) {
            blocks.push(Object.assign({ type: 'tool_result', id: b.tool_use_id, isError: !!b.is_error }, clip(mixed.text)));
          }
          for (const img of mixed.images) blocks.push(img);
        } else {
          const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2);
          blocks.push(Object.assign({ type: 'tool_result', id: b.tool_use_id, isError: !!b.is_error }, clip(c)));
        }
      } else {
        blocks.push(Object.assign({ type: b.type || 'unknown' }, clip(JSON.stringify(b).slice(0, 2000))));
      }
    }
    if (!blocks.length) continue;

    const usage = m.usage;
    messages.push({
      i: i++,
      role: row.type,
      ts: row.timestamp,
      uuid: row.uuid,
      requestId: row.requestId || null,
      model: m.model || null,
      effort: row.effort || null,
      isSidechain: !!row.isSidechain,
      isToolReturn: row.type === 'user' && !!row.toolUseResult,
      // Inyectado = turno de usuario que vos no escribiste.
      injected: row.type === 'user' && !row.toolUseResult && !isHumanTurn(row),
      injectedKind: row.type === 'user' && !row.toolUseResult && !isHumanTurn(row)
        ? injectedKind(textOf(row.message))
        : null,
      // Conversacion = lo que se dijeron. Todo lo demas (herramientas,
      // resultados, adjuntos del harness) es maquinaria y se puede ocultar.
      isConversation: blocks.some((b) => b.type === 'text' || b.type === 'image')
        && !(row.type === 'user' && !!row.toolUseResult),
      blocks,
      usage: usage ? {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        thinking: (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        costUSD: pricing.costOf(m.model, usage, usage.speed),
      } : null,
    });
  }

  // Colapsa las filas repetidas del mismo requestId (streaming): queda la ultima.
  const byReq = new Map();
  const final = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.requestId) {
      if (byReq.has(msg.requestId)) {
        final[byReq.get(msg.requestId)] = msg;
        continue;
      }
      byReq.set(msg.requestId, final.length);
    }
    final.push(msg);
  }
  return final;
}

// --- busqueda full-text ----------------------------------------------------

function makeMatcher(query, opts) {
  const o = opts || {};
  if (o.regex) {
    const re = new RegExp(query, o.caseSensitive ? '' : 'i');
    return {
      quick: (l) => re.test(l),
      find: (t) => { const m = re.exec(t); return m ? m.index : -1; },
    };
  }
  const q = o.caseSensitive ? query : query.toLowerCase();
  return {
    quick: (l) => (o.caseSensitive ? l : l.toLowerCase()).includes(q),
    find: (t) => (o.caseSensitive ? t : t.toLowerCase()).indexOf(q),
  };
}

async function searchFile(entry, matcher, limitPerFile) {
  const hits = [];
  const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (hits.length >= limitPerFile) break;
    if (!line.trim()) continue;
    if (!matcher.quick(line)) continue; // filtro barato antes de parsear JSON
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const text = textOf(row.message);
    if (!text) continue;
    const at = matcher.find(text);
    if (at < 0) continue;
    hits.push({
      sessionId: entry.sessionId,
      role: row.type,
      ts: row.timestamp,
      uuid: row.uuid,
      isSidechain: !!row.isSidechain,
      snippet: text.slice(Math.max(0, at - 120), at + 240).replace(/\s+/g, ' ').trim(),
    });
  }
  rl.close();
  stream.destroy();
  return hits;
}

// Devuelve UNA imagen completa releyendo el transcript. Se usa al hacer clic:
// asi el hilo viaja liviano y solo se paga el peso de lo que mires.
async function readImage(file, ref) {
  if (!ref) return null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let fila = -1;
  try {
    for await (const line of rl) {
      fila++;
      if (fila !== ref.fila) continue;
      let row;
      try { row = JSON.parse(line); } catch { return null; }
      const bloques = blocksOf(row.message);
      const b = bloques[ref.bloque];
      if (!b) return null;
      let img = b;
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        img = b.content.filter((c) => c && c.type === 'image')[ref.sub || 0];
      }
      if (!img || img.type !== 'image') return null;
      const src = img.source || {};
      if (!src.data) return null;
      return {
        dataUri: `data:${src.media_type || 'image/png'};base64,${src.data}`,
        media: src.media_type || 'image/png',
        bytes: Math.round((src.data.length * 3) / 4),
      };
    }
  } finally {
    rl.close();
  }
  return null;
}

module.exports = {
  listTranscriptFiles, summarize, loadThread, readImage, cleanPrompt, isHumanTurn,
  searchFile, makeMatcher, totalsOf, blocksOf, textOf,
};
