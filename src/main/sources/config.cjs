'use strict';
const fs = require('fs');
const path = require('path');
const { P, readJSON, listDir, statSafe } = require('./paths.cjs');

// ---- ~/.claude.json : cuenta, limites, MCPs, skills ----------------------

function readClaudeJson() {
  return readJSON(P.CLAUDE_JSON, {}) || {};
}

function account(cj) {
  const a = cj.oauthAccount || {};
  return {
    email: a.emailAddress || null,
    displayName: a.displayName || a.fullName || null,
    organizationName: a.organizationName || null,
    organizationType: a.organizationType || null,
    organizationRole: a.organizationRole || null,
    seatTier: a.seatTier || null,
    billingType: a.billingType || null,
    hasExtraUsageEnabled: !!a.hasExtraUsageEnabled,
    accountCreatedAt: a.accountCreatedAt || null,
    subscriptionCreatedAt: a.subscriptionCreatedAt || null,
    firstTokenDate: cj.claudeCodeFirstTokenDate || null,
    installMethod: cj.installMethod || null,
    numStartups: cj.numStartups || 0,
    // se guarda el token? no. solo miramos si el archivo existe.
    hasCredentialsFile: !!statSafe(path.join(P.CLAUDE_DIR, '.credentials.json')),
  };
}

// Esto es exactamente lo que muestra /usage. Claude Code lo refresca solo
// cada vez que lo usas, asi que no hace falta loguearse aparte.
function usageLimits(cj) {
  const c = cj.cachedUsageUtilization || null;
  if (!c) return null;
  const meters = [];
  const nice = {
    five_hour: 'Ventana de 5 horas',
    seven_day: 'Ventana de 7 dias',
    seven_day_opus: '7 dias (Opus)',
    seven_day_sonnet: '7 dias (Sonnet)',
    seven_day_oauth_apps: '7 dias (apps OAuth)',
    seven_day_cowork: '7 dias (Cowork)',
  };
  for (const [key, v] of Object.entries(c.utilization || {})) {
    if (!v || typeof v.utilization !== 'number') continue;
    meters.push({
      key,
      label: nice[key] || key,
      utilization: v.utilization,
      resetsAt: v.resets_at || null,
      limitDollars: v.limit_dollars,
      usedDollars: v.used_dollars,
      remainingDollars: v.remaining_dollars,
      lockedReason: v.locked_reason || null,
    });
  }
  meters.sort((a, b) => b.utilization - a.utilization);
  return { fetchedAtMs: c.fetchedAtMs || null, meters };
}

// Modelos que el selector de Claude Code te ofrece ademas de los del plan.
// Claude Code guarda estas descripciones con la codificacion rota (UTF-8 leido
// como latin-1), asi que se limpian las secuencias tipicas antes de mostrarlas.
function fixMojibake(s) {
  return String(s || '')
    .replace(/ÃÂ·|Â·/g, '·')
    .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í').replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú').replace(/Ã±/g, 'ñ');
}

function availableModels(cj) {
  const extra = Array.isArray(cj.additionalModelOptionsCache) ? cj.additionalModelOptionsCache : [];
  const access = Array.isArray(cj.modelAccessCache) ? cj.modelAccessCache : [];
  const out = extra.map((m) => ({
    id: m.value,
    label: m.label || m.value,
    description: fixMojibake(m.description),
    // Los modelos "extra" no salen del plan: consumen creditos de uso extra.
    usesCredits: /usage credits|creditos/i.test(String(m.description || '')),
    source: 'opcion adicional',
  }));
  for (const m of access) {
    const id = typeof m === 'string' ? m : (m && (m.value || m.model));
    if (id && !out.some((x) => x.id === id)) {
      out.push({ id, label: id, description: null, usesCredits: false, source: 'plan' });
    }
  }
  return out;
}

// ---- MCP -----------------------------------------------------------------

function mcpServers(cj) {
  // mcp-needs-auth-cache.json es { "<nombre>": { timestamp, id } }
  const authCache = readJSON(P.mcpAuthCache, {}) || {};
  const out = [];
  const push = (name, def, scope, project) => {
    const d = def || {};
    const auth = authCache[name];
    out.push({
      name,
      scope,
      project: project || null,
      transport: d.type || (d.url ? 'http/sse' : 'stdio'),
      command: d.command || d.url || null,
      args: d.args || null,
      needsAuth: !!auth,
      authFlaggedAt: auth ? auth.timestamp : null,
      remoteId: auth ? auth.id : null,
    });
  };
  for (const [n, d] of Object.entries(cj.mcpServers || {})) push(n, d, 'usuario');
  const fromFile = readJSON(P.mcpJson, {}) || {};
  for (const [n, d] of Object.entries(fromFile.mcpServers || {})) {
    if (!out.some((s) => s.name === n)) push(n, d, '.mcp.json');
  }
  // El mismo proyecto aparece con "c:" y "C:": se cuenta una sola vez.
  const seenProject = new Set();
  for (const [proj, pd] of Object.entries(cj.projects || {})) {
    for (const [n, d] of Object.entries((pd && pd.mcpServers) || {})) {
      const key = n + '@' + String(proj).replace(/[\\/]+/g, '/').toLowerCase();
      if (seenProject.has(key)) continue;
      seenProject.add(key);
      push(n, d, 'proyecto', proj);
    }
  }
  // conectores de claude.ai que solo aparecen en la cache de auth
  for (const [n, a] of Object.entries(authCache)) {
    if (!out.some((s) => s.name === n)) {
      out.push({
        name: n, scope: 'claude.ai', project: null, transport: 'conector',
        command: null, args: null, needsAuth: true,
        authFlaggedAt: a && a.timestamp, remoteId: a && a.id,
      });
    }
  }
  return out;
}

// ---- settings / hooks ----------------------------------------------------

function settings() {
  const user = readJSON(P.settings, {}) || {};
  const local = readJSON(P.settingsLocal, {}) || {};
  const hooks = [];
  for (const src of [{ f: 'settings.json', s: user }, { f: 'settings.local.json', s: local }]) {
    for (const [event, entries] of Object.entries((src.s && src.s.hooks) || {})) {
      for (const e of entries || []) {
        for (const h of e.hooks || []) {
          hooks.push({
            event,
            matcher: e.matcher || '*',
            type: h.type,
            command: h.command,
            timeout: h.timeout || null,
            source: src.f,
          });
        }
      }
    }
  }
  return {
    user, local, hooks,
    model: user.model || local.model || null,
    effortLevel: user.effortLevel || local.effortLevel || null,
    theme: user.theme || null,
    env: Object.assign({}, user.env, local.env),
  };
}

// ---- skills / workflows / plugins / agentes ------------------------------

function readFrontmatterDescription(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!m) return null;
    const d = /^description:\s*(.+)$/m.exec(m[1]);
    return d ? d[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

// Las skills viven en cuatro lugares distintos y solo uno es obvio:
//   ~/.claude/skills/<skill>/SKILL.md                          -> usuario
//   <repo>/.claude/skills/  y  <repo>/.agents/skills/          -> proyecto
//   ~/.claude/plugins/marketplaces/<m>/plugins/<p>/skills/     -> plugin
//   dentro del binario de Claude Code                          -> integradas
// Las integradas no tienen archivo en disco (solo se extraen sus anexos a
// temp cuando las usas), asi que de esas no hay descripcion para mostrar.
function scanSkillDir(dir, scope, source) {
  const out = [];
  for (const d of listDir(dir)) {
    if (!d.isDirectory()) continue;
    const skillDir = path.join(dir, d.name);
    const md = path.join(skillDir, 'SKILL.md');
    if (!statSafe(md)) continue;
    out.push({
      name: d.name,
      scope,
      source: source || null,
      path: skillDir,
      description: readFrontmatterDescription(md),
    });
  }
  return out;
}

function skills(cj) {
  const usage = cj.skillUsage || {};
  const found = new Map();
  const add = (list) => {
    for (const s of list) if (!found.has(s.name)) found.set(s.name, s);
  };

  add(scanSkillDir(P.skills, 'usuario'));

  // skills de plugins de cada marketplace
  for (const mk of listDir(path.join(P.plugins, 'marketplaces'))) {
    if (!mk.isDirectory()) continue;
    const pluginsDir = path.join(P.plugins, 'marketplaces', mk.name, 'plugins');
    for (const pl of listDir(pluginsDir)) {
      if (!pl.isDirectory()) continue;
      add(scanSkillDir(path.join(pluginsDir, pl.name, 'skills'), 'plugin', pl.name));
    }
  }

  // skills del propio repo, en las dos convenciones que se usan
  const seenRoot = new Set();
  for (const p of Object.keys(cj.projects || {})) {
    const root = path.resolve(p);
    const key = root.toLowerCase();
    if (seenRoot.has(key) || !statSafe(root)) continue;
    seenRoot.add(key);
    const label = path.basename(root);
    add(scanSkillDir(path.join(root, '.claude', 'skills'), 'proyecto', label));
    add(scanSkillDir(path.join(root, '.agents', 'skills'), 'proyecto', label));
  }

  const out = [];
  for (const [name, u] of Object.entries(usage)) {
    const f = found.get(name);
    out.push({
      name,
      scope: f ? f.scope : 'integrada',
      source: f ? f.source : 'Claude Code',
      path: f ? f.path : null,
      description: f ? f.description : null,
      // Las integradas viven dentro del binario: no hay SKILL.md que leer.
      descriptionUnavailable: !f,
      usageCount: u.usageCount || 0,
      lastUsedAt: u.lastUsedAt || null,
    });
    found.delete(name);
  }
  for (const f of found.values()) {
    out.push(Object.assign({ usageCount: 0, lastUsedAt: null, descriptionUnavailable: false }, f));
  }
  out.sort((a, b) => (b.usageCount - a.usageCount) || a.name.localeCompare(b.name));
  return out;
}

function workflows() {
  return listDir(P.workflows)
    .filter((f) => f.isFile())
    .map((f) => {
      const full = path.join(P.workflows, f.name);
      const st = statSafe(full);
      let meta = null;
      try {
        const src = fs.readFileSync(full, 'utf8');
        const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(src);
        if (m) {
          const name = /name:\s*['"`](.*?)['"`]/.exec(m[1]);
          const desc = /description:\s*['"`](.*?)['"`]/.exec(m[1]);
          meta = { name: name && name[1], description: desc && desc[1] };
        }
      } catch { /* ignora */ }
      return {
        file: f.name, path: full,
        name: (meta && meta.name) || f.name.replace(/\.[jt]s$/, ''),
        description: meta && meta.description,
        sizeBytes: st ? st.size : 0,
        mtimeMs: st ? st.mtimeMs : 0,
      };
    });
}

function plugins() {
  const known = readJSON(path.join(P.plugins, 'known_marketplaces.json'), {}) || {};
  const marketplaces = listDir(path.join(P.plugins, 'marketplaces'))
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(P.plugins, 'marketplaces', d.name);
      const manifest =
        readJSON(path.join(dir, '.claude-plugin', 'marketplace.json')) ||
        readJSON(path.join(dir, 'marketplace.json')) || {};
      const list = Array.isArray(manifest.plugins) ? manifest.plugins : [];
      return {
        name: d.name,
        path: dir,
        pluginCount: list.length,
        plugins: list.map((p) => ({ name: p.name, description: p.description || null })),
      };
    });
  return { known: Object.keys(known), marketplaces };
}

function projectsConfig(cj) {
  return Object.entries(cj.projects || {}).map(([p, v]) => ({
    path: p,
    trusted: !!(v && v.hasTrustDialogAccepted),
    allowedTools: (v && v.allowedTools) || [],
    mcpServers: Object.keys((v && v.mcpServers) || {}),
    enabledMcpjsonServers: (v && v.enabledMcpjsonServers) || [],
    disabledMcpjsonServers: (v && v.disabledMcpjsonServers) || [],
  }));
}

function promptHistory(limit) {
  const out = [];
  try {
    const lines = fs.readFileSync(P.history, 'utf8').split(/\r?\n/);
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        out.push({
          display: o.display, ts: o.timestamp,
          project: o.project, sessionId: o.sessionId,
        });
      } catch { /* ignora */ }
    }
  } catch { /* ignora */ }
  out.reverse();
  return limit ? out.slice(0, limit) : out;
}

function readAll() {
  const cj = readClaudeJson();
  return {
    account: account(cj),
    availableModels: availableModels(cj),
    usageLimits: usageLimits(cj),
    mcpServers: mcpServers(cj),
    settings: settings(),
    skills: skills(cj),
    workflows: workflows(),
    plugins: plugins(),
    projects: projectsConfig(cj),
    promptHistory: promptHistory(300),
    paths: {
      claudeDir: P.CLAUDE_DIR,
      claudeJson: P.CLAUDE_JSON,
      settings: P.settings,
      projects: P.projects,
      usageData: P.usageData,
    },
    statsCache: readJSON(P.statsCache, null),
  };
}

module.exports = { readAll, readClaudeJson, usageLimits, account };
