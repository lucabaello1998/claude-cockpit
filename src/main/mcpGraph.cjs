'use strict';
const { spawn } = require('child_process');
const { P, readJSON } = require('./sources/paths.cjs');

// Cliente MCP por stdio para hablarle al servidor de codebase-memory y poder
// explorar el grafo desde la app. El protocolo es JSON-RPC 2.0 con un mensaje
// por linea (no hay framing con Content-Length en el transporte stdio).
//
// El proceso se levanta la primera vez que lo necesitas y se apaga solo
// despues de un rato sin uso: arrancarlo cuesta ~1s y reserva memoria.

const IDLE_MS = 120000;
const CALL_TIMEOUT_MS = 30000;

function serverCommand() {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const fromUser = (cj.mcpServers || {})['codebase-memory-mcp'];
  const fromFile = ((readJSON(P.mcpJson, {}) || {}).mcpServers || {})['codebase-memory-mcp'];
  const def = fromUser || fromFile;
  if (!def || !def.command) return null;
  return { command: def.command, args: def.args || [] };
}

class McpGraph {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.idleTimer = null;
  }

  available() {
    return !!serverCommand();
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ya murio */ }
      this.proc = null;
    }
    this.ready = null;
    for (const [, p] of this.pending) p.reject(new Error('El servidor de grafo se cerro.'));
    this.pending.clear();
    this.buf = '';
  }

  _start() {
    if (this.ready) return this.ready;
    const cmd = serverCommand();
    if (!cmd) return Promise.reject(new Error('No hay un servidor codebase-memory-mcp configurado.'));

    this.ready = new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(new Error('No se pudo iniciar el servidor: ' + e.message));
      }
      this.proc = proc;

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this._onData(chunk));
      // El servidor escribe logs en stderr; no son errores del protocolo.
      proc.stderr.on('data', () => {});
      proc.on('error', (e) => { this.stop(); reject(new Error('Fallo el servidor: ' + e.message)); });
      proc.on('exit', () => { this.stop(); });

      this._rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-cockpit', version: '1.0.0' },
      }, true)
        .then(() => {
          this._notify('notifications/initialized');
          resolve();
        })
        .catch(reject);
    });
    return this.ready;
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'error del servidor de grafo'));
      else p.resolve(msg.result);
    }
  }

  _notify(method, params) {
    if (this.proc) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  _rpc(method, params, skipStart) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('El servidor de grafo no esta corriendo.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('El servidor de grafo no respondio a tiempo.'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  async call(tool, args) {
    await this._start();
    this._touch();
    const res = await this._rpc('tools/call', { name: tool, arguments: args || {} });
    return unwrap(res);
  }
}

// Las respuestas vienen como content[{type:'text', text:'<json o texto>'}].
function unwrap(result) {
  if (!result) return null;
  const blocks = result.content || [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  if (!text) return result.structuredContent || result;
  try { return JSON.parse(text); } catch { return { text }; }
}

const client = new McpGraph();

// --- API que consume la app ------------------------------------------------

async function projects() {
  const r = await client.call('list_projects', {});
  const list = (r && r.projects) || [];
  return list.map((p) => ({
    name: p.name,
    rootPath: p.root_path || null,
    nodes: p.nodes || 0,
    edges: p.edges || 0,
    sizeBytes: p.size_bytes || 0,
  }));
}

async function architecture(project, aspects) {
  return client.call('get_architecture', aspects ? { project, aspects } : { project });
}

async function schema(project) {
  return client.call('get_graph_schema', { project });
}

async function search(project, opts) {
  const o = opts || {};
  const args = { project, limit: o.limit || 60 };
  if (o.namePattern) args.name_pattern = o.namePattern;
  if (o.label) args.label = o.label;
  if (o.filePattern) args.file_pattern = o.filePattern;
  if (o.semantic) args.semantic_query = o.semantic;
  if (o.query) args.query = o.query;
  const r = await client.call('search_graph', args);
  return normalizeNodes(r);
}

async function snippet(project, qualifiedName, includeNeighbors) {
  return client.call('get_code_snippet', {
    project,
    qualified_name: qualifiedName,
    include_neighbors: !!includeNeighbors,
  });
}

async function trace(project, functionName, opts) {
  const o = opts || {};
  return client.call('trace_path', {
    project,
    function_name: functionName,
    mode: o.mode || 'calls',
    direction: o.direction || 'both',
    depth: o.depth || 3,
  });
}

async function query(project, cypher, maxRows) {
  return client.call('query_graph', { project, query: cypher, max_rows: maxRows || 400 });
}

async function status(project) {
  return client.call('index_status', { project });
}

// --- subgrafo para dibujar --------------------------------------------------

// Relaciones que se muestran por defecto. DEFINES y CONTAINS_* son la jerarquia
// carpeta/archivo/simbolo: son la mayoria de las aristas y convierten el dibujo
// en un arbol gigante sin informacion util, asi que quedan fuera salvo pedido.
const DEFAULT_RELS = ['CALLS', 'IMPORTS', 'USAGE', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES'];

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function firstLabel(v) {
  if (Array.isArray(v)) return v[0] || null;
  if (typeof v === 'string') {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a[0] : v; } catch { return v; }
  }
  return null;
}

async function subgraph(project, opts) {
  const o = opts || {};
  const relList = (o.relationships && o.relationships.length ? o.relationships : DEFAULT_RELS)
    .filter((r) => /^[A-Z_]+$/.test(r));
  const limit = Math.min(o.limit || 300, 900);

  // Este dialecto no acepta `WHERE type(r) = '...'` ni `IN [...]`: el filtro de
  // relaciones va en el propio patron, separado por `|`.
  const pattern = '(a)-[r:' + relList.join('|') + ']->(b)';
  const where = o.around
    ? ` WHERE a.qualified_name = '${esc(o.around)}' OR b.qualified_name = '${esc(o.around)}'`
    : '';

  const cypher =
    'MATCH ' + pattern + where +
    ' RETURN a.name AS an, a.qualified_name AS aq, labels(a) AS al,' +
    ' type(r) AS rel, b.name AS bn, b.qualified_name AS bq, labels(b) AS bl' +
    ' LIMIT ' + limit;

  const res = await query(project, cypher, limit);
  if (res && res.text) throw new Error(res.text);

  const cols = {};
  (res.columns || []).forEach((c, i) => { cols[c] = i; });
  const nodes = new Map();
  const edges = [];

  const addNode = (qn, name, label) => {
    if (!qn) return null;
    if (!nodes.has(qn)) {
      nodes.set(qn, { id: qn, name: name || qn, label: firstLabel(label), degree: 0 });
    }
    return nodes.get(qn);
  };

  for (const row of res.rows || []) {
    const aq = row[cols.aq];
    const bq = row[cols.bq];
    const a = addNode(aq, row[cols.an], row[cols.al]);
    const b = addNode(bq, row[cols.bn], row[cols.bl]);
    if (!a || !b || a === b) continue;
    a.degree++; b.degree++;
    edges.push({ source: aq, target: bq, rel: row[cols.rel] });
  }

  return {
    nodes: [...nodes.values()],
    edges,
    truncated: (res.rows || []).length >= limit,
    relationships: o.relationships && o.relationships.length ? o.relationships : DEFAULT_RELS,
  };
}

// La forma exacta de la respuesta cambia entre versiones del servidor, asi que
// se aceptan varias y se normaliza a una sola lista.
function normalizeNodes(r) {
  if (!r) return [];
  const raw = Array.isArray(r) ? r
    : Array.isArray(r.nodes) ? r.nodes
    : Array.isArray(r.results) ? r.results
    : Array.isArray(r.matches) ? r.matches : [];
  return raw.map((n) => ({
    name: n.name || n.qualified_name || n.qn || '(sin nombre)',
    qualifiedName: n.qualified_name || n.qn || n.name || null,
    label: n.label || (Array.isArray(n.labels) ? n.labels[0] : null) || null,
    file: n.file || n.file_path || n.path || null,
    line: n.line || n.start_line || null,
    degree: n.degree != null ? n.degree : null,
    raw: n,
  }));
}

module.exports = {
  available: () => client.available(),
  projects, architecture, schema, search, snippet, trace, status, query, subgraph,
  DEFAULT_RELS,
  stop: () => client.stop(),
};
