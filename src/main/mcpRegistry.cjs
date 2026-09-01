'use strict';
const https = require('https');

// Buscador contra el registro oficial de MCP.
//   https://registry.modelcontextprotocol.io/v0/servers
// Es el indice publico de servidores, mantenido por la comunidad junto con
// Anthropic, GitHub, Microsoft y PulseMCP.
//
// OJO con la palabra "marketplace": esto NO es una tienda curada. Cualquiera
// publica ahi. Instalar un servidor significa correr codigo de un tercero en tu
// maquina, con acceso a lo que Claude Code pueda hacer. Por eso la app nunca
// instala sola: muestra el comando exacto que va a escribir y espera que lo
// confirmes.

const BASE = 'https://registry.modelcontextprotocol.io/v0';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'claude-cockpit/1.0', Accept: 'application/json' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('El registro respondió ' + res.statusCode));
      }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { reject(new Error('El registro devolvió algo que no es JSON.')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('El registro tardó demasiado.')); });
    req.on('error', (e) => reject(new Error('No se pudo llegar al registro: ' + e.message)));
  });
}

// El registro devuelve una entrada por VERSION publicada. Sin agrupar, buscar
// "filesystem" trae el mismo servidor cuatro veces.
function dedupe(entradas) {
  const porNombre = new Map();
  for (const e of entradas) {
    const s = e.server || {};
    if (!s.name) continue;
    const meta = (e._meta && e._meta['io.modelcontextprotocol.registry/official']) || {};
    const prev = porNombre.get(s.name);
    const esMejor = !prev
      || (meta.isLatest && !prev.isLatest)
      || (meta.isLatest === prev.isLatest && String(s.version || '').localeCompare(String(prev.version || ''), undefined, { numeric: true }) > 0);
    if (esMejor) {
      porNombre.set(s.name, {
        name: s.name,
        title: s.title || s.name,
        description: s.description || '',
        version: s.version || null,
        isLatest: !!meta.isLatest,
        status: meta.status || null,
        packages: (s.packages || []).map(normalizePackage).filter(Boolean),
        remotes: (s.remotes || []).map((r) => ({ type: r.type, url: r.url })),
      });
    }
  }
  return [...porNombre.values()];
}

// Traduce un paquete del registro a algo que Claude Code entienda.
// Los argumentos tienen un orden definido por el registro:
//   <runtime> <runtimeArguments...> <paquete> <packageArguments...>
// Es decir: lo que va antes del nombre del paquete configura al runtime (npx,
// docker), y lo que va despues es para el servidor. Mezclarlos rompe el comando.
function argsDe(lista) {
  const out = [];
  for (const a of lista || []) {
    if (!a) continue;
    if (a.type === 'named' && a.name) {
      out.push(String(a.name));
      if (a.value != null && a.value !== '') out.push(String(a.value));
      else if (a.isRequired) out.push('<' + (a.description || 'valor').slice(0, 20) + '>');
    } else if (a.value != null && a.value !== '') {
      out.push(String(a.value));
    } else if (a.isRequired) {
      out.push('<' + (a.description || a.name || 'valor').slice(0, 20) + '>');
    }
  }
  return out;
}

function normalizePackage(p) {
  if (!p) return null;
  const tipo = p.registryType || p.registry_type;
  const id = p.identifier;
  if (!id) return null;

  const runtime = argsDe(p.runtimeArguments);
  const delPaquete = argsDe(p.packageArguments);
  let command = null;
  let args = [];

  if (tipo === 'npm') {
    command = p.runtimeHint || 'npx';
    // -y solo si el registro no lo trajo ya en runtimeArguments.
    if (!runtime.includes('-y') && !runtime.includes('--yes')) runtime.unshift('-y');
    args = runtime.concat([p.version ? `${id}@${p.version}` : id], delPaquete);
  } else if (tipo === 'pypi') {
    command = p.runtimeHint || 'uvx';
    args = runtime.concat([p.version ? `${id}==${p.version}` : id], delPaquete);
  } else if (tipo === 'oci') {
    command = 'docker';
    const base = ['run', '-i', '--rm'];
    args = base.concat(runtime.filter((a) => !base.includes(a)), [id], delPaquete);
  } else if (tipo === 'nuget' || tipo === 'mcpb') {
    command = p.runtimeHint || null;
    if (command) args = runtime.concat([id], delPaquete);
  }
  if (!command) return null;

  return {
    registryType: tipo,
    identifier: id,
    version: p.version || null,
    transport: (p.transport && p.transport.type) || 'stdio',
    command,
    args,
    env: (p.environmentVariables || []).map((v) => ({
      name: v.name,
      description: v.description || '',
      required: !!v.isRequired,
      secret: !!v.isSecret,
      default: v.default != null ? String(v.default) : '',
    })),
  };
}

async function search(q, cursor) {
  const params = new URLSearchParams({ limit: '30' });
  if (q && q.trim()) params.set('search', q.trim());
  if (cursor) params.set('cursor', cursor);
  const j = await getJson(`${BASE}/servers?${params.toString()}`);
  return {
    servers: dedupe(j.servers || []),
    nextCursor: (j.metadata && j.metadata.nextCursor) || null,
  };
}

// Nombre corto y valido para usar como clave en ~/.claude.json.
// "io.github.Digital-Defiance/mcp-filesystem" -> "mcp-filesystem"
function suggestName(fullName) {
  const ultimo = String(fullName).split('/').pop() || String(fullName);
  return ultimo.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'servidor-mcp';
}

module.exports = { search, suggestName, normalizePackage, BASE };
