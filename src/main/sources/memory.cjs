'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { P, readJSON, listDir, statSafe } = require('./paths.cjs');

// Tres cosas distintas se llaman "memoria". La app las separa:
//   1. claude-memory : ~/.claude/projects/<proj>/memory/*.md (los archivos que
//      escribe Claude Code con MEMORY.md como indice)
//   2. codebase-memory : <repo>/.codebase-memory/{artifact.json,graph.db.zst}
//   3. graphify : <repo>/graphify-out/{manifest.json,graph.json} y
//      ~/.graphify/global-graph.json

// ---- raices de proyecto conocidas ----------------------------------------

function projectRoots() {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  // El mismo repo aparece con distinta capitalizacion de unidad ("c:" y "C:"):
  // se deduplica por clave normalizada para no listar el store dos veces.
  const byKey = new Map();
  for (const p of Object.keys(cj.projects || {})) {
    if (!p) continue;
    const abs = path.resolve(p);
    const key = abs.toLowerCase();
    if (!byKey.has(key) && statSafe(abs)) byKey.set(key, abs);
  }
  return [...byKey.values()];
}

// ---- 1. memoria de Claude Code -------------------------------------------

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      currentKey = top[1];
      meta[currentKey] = top[2].trim();
    } else {
      const nested = /^\s+(\w[\w-]*):\s*(.*)$/.exec(line);
      if (nested && currentKey) {
        if (typeof meta[currentKey] !== 'object' || !meta[currentKey]) meta[currentKey] = {};
        meta[currentKey][nested[1]] = nested[2].trim();
      }
    }
  }
  return { meta, body: m[2] };
}

function claudeMemories() {
  const stores = [];
  for (const projDir of listDir(P.projects)) {
    if (!projDir.isDirectory()) continue;
    const dir = path.join(P.projects, projDir.name, 'memory');
    const files = listDir(dir).filter((f) => f.isFile() && f.name.endsWith('.md'));
    if (!files.length) continue;
    const entries = [];
    let index = null;
    for (const f of files) {
      const full = path.join(dir, f.name);
      const st = statSafe(full);
      let raw = '';
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (f.name.toUpperCase() === 'MEMORY.MD') {
        index = { file: f.name, path: full, body: raw, mtimeMs: st ? st.mtimeMs : 0 };
        continue;
      }
      const { meta, body } = parseFrontmatter(raw);
      entries.push({
        file: f.name,
        path: full,
        name: meta.name || f.name.replace(/\.md$/, ''),
        description: meta.description || null,
        type: (meta.metadata && meta.metadata.type) || meta.type || 'sin tipo',
        body: body.trim(),
        links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
        sizeBytes: st ? st.size : 0,
        mtimeMs: st ? st.mtimeMs : 0,
      });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    stores.push({ projectDir: projDir.name, dir, index, entries });
  }
  return stores;
}

// ---- 2. codebase-memory ---------------------------------------------------

function gitHead(repo) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeout: 4000 }, (err, out) => {
      resolve(err ? null : String(out).trim());
    });
  });
}

async function codebaseMemory(roots) {
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, '.codebase-memory');
    const artifactPath = path.join(dir, 'artifact.json');
    if (!statSafe(artifactPath)) continue;
    const a = readJSON(artifactPath, {}) || {};
    const dbPath = path.join(dir, 'graph.db.zst');
    const dbStat = statSafe(dbPath);
    const head = await gitHead(root);
    out.push({
      provider: 'codebase-memory',
      root,
      name: path.basename(root),
      dir,
      project: a.project || null,
      schemaVersion: a.schema_version || null,
      nodes: a.nodes || 0,
      edges: a.edges || 0,
      indexedAt: a.indexed_at || null,
      indexedCommit: a.commit || null,
      currentCommit: head,
      stale: !!(head && a.commit && head !== a.commit),
      compressedBytes: a.compressed_size || (dbStat ? dbStat.size : 0),
      originalBytes: a.original_size || 0,
      dbMtimeMs: dbStat ? dbStat.mtimeMs : null,
    });
  }
  return out;
}

// ---- 3. graphify ----------------------------------------------------------

// graph.json puede ser enorme: contamos nodos/edges sin cargarlo entero.
function scanGraphJson(file, maxBytes) {
  const st = statSafe(file);
  if (!st) return null;
  if (st.size <= (maxBytes || 40 * 1024 * 1024)) {
    const g = readJSON(file, null);
    if (g) {
      const nodes = Array.isArray(g.nodes) ? g.nodes.length : (g.node_count || 0);
      const edges = Array.isArray(g.edges) ? g.edges.length
        : Array.isArray(g.links) ? g.links.length : (g.edge_count || 0);
      return { nodes, edges, sizeBytes: st.size, mtimeMs: st.mtimeMs, exact: true };
    }
  }
  return { nodes: null, edges: null, sizeBytes: st.size, mtimeMs: st.mtimeMs, exact: false };
}

function graphifyStores(roots) {
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, 'graphify-out');
    if (!statSafe(dir)) continue;
    const manifest = readJSON(path.join(dir, 'manifest.json'), {}) || {};
    const graph = scanGraphJson(path.join(dir, 'graph.json'));
    const report = statSafe(path.join(dir, 'GRAPH_REPORT.md'));
    out.push({
      provider: 'graphify',
      root,
      name: path.basename(root),
      dir,
      project: manifest.project || manifest.name || path.basename(root),
      nodes: graph ? graph.nodes : null,
      edges: graph ? graph.edges : null,
      exact: graph ? graph.exact : false,
      indexedAt: manifest.generated_at || manifest.created_at || manifest.indexed_at || null,
      indexedCommit: manifest.commit || null,
      currentCommit: null,
      stale: false,
      compressedBytes: graph ? graph.sizeBytes : 0,
      originalBytes: 0,
      dbMtimeMs: graph ? graph.mtimeMs : null,
      hasReport: !!report,
      reportPath: report ? path.join(dir, 'GRAPH_REPORT.md') : null,
      hasHtml: !!statSafe(path.join(dir, 'graph.html')),
      htmlPath: statSafe(path.join(dir, 'graph.html')) ? path.join(dir, 'graph.html') : null,
      manifest,
    });
  }
  const globalGraph = path.join(P.graphifyHome, 'global-graph.json');
  const g = scanGraphJson(globalGraph);
  return {
    stores: out,
    installed: !!statSafe(P.graphifyHome) || out.length > 0,
    global: g ? Object.assign({ path: globalGraph }, g) : null,
  };
}

// Claude Code codifica el cwd como nombre de carpeta cambiando ":", "/", "\\"
// y "_" por "-". La codificacion es lossy, asi que se usa solo como fallback
// cuando no hay ningun transcript del que sacar el cwd real.
function encodeProjectDir(p) {
  return String(p).replace(/[:\\/_]/g, '-').toLowerCase();
}

function resolveByEncoding(projectDir, roots) {
  const target = String(projectDir).toLowerCase();
  return roots.find((r) => encodeProjectDir(r) === target) || null;
}

// ---- agregado -------------------------------------------------------------

async function readAll() {
  const roots = projectRoots();
  const cbm = await codebaseMemory(roots);
  const gfy = graphifyStores(roots);
  const claudeMemory = claudeMemories();
  for (const store of claudeMemory) {
    store.projectPath = resolveByEncoding(store.projectDir, roots);
  }
  return {
    roots,
    claudeMemory,
    providers: [
      {
        id: 'codebase-memory',
        label: 'Codebase Memory',
        installed: !!statSafe(path.join(P.HOME, 'AppData', 'Local', 'Programs', 'codebase-memory-mcp')) || cbm.length > 0,
        stores: cbm,
      },
      {
        id: 'graphify',
        label: 'Graphify',
        installed: gfy.installed,
        stores: gfy.stores,
        global: gfy.global,
      },
    ],
  };
}

module.exports = { readAll, projectRoots };
