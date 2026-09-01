'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { P } = require('./paths.cjs');

// Consulta en vivo de los medidores de uso, el mismo endpoint que usa /usage:
//   GET https://api.anthropic.com/api/oauth/usage
// con el token OAuth de ~/.claude/.credentials.json.
//
// Reglas que se respetan a proposito:
//   - el token se lee recien cuando el usuario aprieta el boton, nunca al arrancar
//   - no se guarda, no se loguea, no se manda a ningun lado que no sea Anthropic
//   - no se escribe nada en ~/.claude.json: el dato en vivo vive solo en memoria,
//     asi no se pisa la config que maneja Claude Code
//   - si el token vencio NO se intenta renovarlo: se le avisa al usuario que
//     abra Claude Code, que es quien tiene que rotar sus credenciales

// Freno de mano contra el 429.
//
// Habia tres fuentes pidiendo lo mismo sin coordinarse: el auto-refresco cada
// 2 min, el monitor cada 10 y el boton "Actualizar uso", que el usuario puede
// apretar cuantas veces quiera. Juntas pasaban el limite del endpoint y la API
// devolvia 429, que en pantalla se veia como un error de la app.
//
// Tres controles, en orden:
//   1. una respuesta de menos de MIN_INTERVALO se reusa en vez de repedirse
//   2. si ya hay una consulta en vuelo, los que llegan esperan ESA, no abren otra
//   3. despues de un 429 no se vuelve a pedir hasta que pase el Retry-After
const MIN_INTERVALO_MS = 45000;
const ESPERA_429_POR_DEFECTO_MS = 60000;
// Un Retry-After de 86400 dejaba la app muda 24 horas. Se respeta lo que pide
// la API pero con techo: pasado eso se vuelve a intentar y, si sigue limitando,
// se bloquea de nuevo.
const ESPERA_429_MAXIMA_MS = 900000;

let ultima = null;       // { at, data }
let enVuelo = null;      // Promise
let bloqueadoHasta = 0;  // epoch ms

const CREDENTIALS = path.join(P.CLAUDE_DIR, '.credentials.json');
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ENDPOINT = '/api/oauth/usage';

const LABELS = {
  five_hour: 'Ventana de 5 horas',
  seven_day: 'Ventana de 7 dias',
  seven_day_opus: '7 dias (Opus)',
  seven_day_sonnet: '7 dias (Sonnet)',
  seven_day_oauth_apps: '7 dias (apps OAuth)',
  seven_day_cowork: '7 dias (Cowork)',
};

class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readCredentials() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
  } catch {
    throw new UsageError(
      'no-credentials',
      'No encontre ~/.claude/.credentials.json. Inicia sesion en Claude Code primero.'
    );
  }
  const o = raw && raw.claudeAiOauth;
  if (!o || !o.accessToken) {
    throw new UsageError('no-credentials', 'El archivo de credenciales no tiene un token OAuth.');
  }
  if (o.expiresAt && Date.now() >= o.expiresAt) {
    throw new UsageError(
      'expired',
      'La sesion de Claude Code vencio. Abri Claude Code una vez para que renueve el token y volve a probar.'
    );
  }
  return { token: o.accessToken, expiresAt: o.expiresAt || null };
}

function request(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(ENDPOINT, BASE);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'claude-cockpit/1.0',
        },
        // Medido: normalmente responde en ~350 ms con 1.7 KB, pero la primera
        // consulta despues de un rato inactivo tardo 11.4 s. Con 10 s eso se
        // convertia en un error visible por nada: la respuesta es chica, y
        // esperar unos segundos de mas es mejor que fallar y hacerte reintentar.
        timeout: 25000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({
          status: res.statusCode, body, retryAfter: res.headers['retry-after'] || null,
        }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new UsageError('timeout', 'Anthropic no respondió en 25 segundos. Probá de nuevo.'));
    });
    req.on('error', (e) =>
      reject(new UsageError('network', 'No se pudo llegar a la API: ' + e.message))
    );
    req.end();
  });
}

// La respuesta trae los MISMOS medidores dos veces:
//   - como claves de primer nivel: five_hour, seven_day, seven_day_opus, ...
//   - otra vez dentro del array `limits`, con otros nombres: session, weekly_all
// Sin unificarlos aparecen barras duplicadas. El objeto de primer nivel es la
// fuente de verdad (trae los campos de dolares); del array solo se toma
// `severity` e `is_active`, que el objeto no tiene.
const ALIAS = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly: 'seven_day',
  weekly_opus: 'seven_day_opus',
  weekly_sonnet: 'seven_day_sonnet',
  weekly_cowork: 'seven_day_cowork',
  weekly_oauth_apps: 'seven_day_oauth_apps',
};

// Claves que no son medidores aunque viajen en el mismo objeto.
const NOT_A_METER = new Set(['limits', 'rate_limits', 'spend', 'extra_usage', 'member_dashboard_available']);

// Anthropic agrega medidores nuevos con nombres internos (nimbus_quill, etc.).
// Mostrar la clave cruda queda feo: se la deja legible hasta que tenga etiqueta.
function etiqueta(key) {
  if (LABELS[key]) return LABELS[key];
  // Una clave compuesta ("seven_day_opus:Opus") pierde LABELS si se busca
  // entera: se prueba tambien con la parte de antes de los dos puntos.
  const base = String(key).split(':')[0];
  if (LABELS[base]) return LABELS[base];
  const s = String(key).replace(/[_:]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

function canonicalKey(kind, scopeName) {
  const base = ALIAS[kind] || kind || 'limite';
  return scopeName ? base + ':' + scopeName : base;
}

function normalize(data) {
  const byKey = new Map();

  const source = (data && (data.utilization || data.usage)) || data;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source)) {
      if (NOT_A_METER.has(k)) continue;
      if (!v || typeof v.utilization !== 'number') continue;
      const key = canonicalKey(k);
      byKey.set(key, {
        key,
        label: etiqueta(key),
        utilization: v.utilization,
        resetsAt: v.resets_at || null,
        limitDollars: v.limit_dollars != null ? v.limit_dollars : null,
        usedDollars: v.used_dollars != null ? v.used_dollars : null,
        remainingDollars: v.remaining_dollars != null ? v.remaining_dollars : null,
        lockedReason: v.locked_reason || null,
        severity: null,
        isActive: false,
      });
    }
  }

  const list = (data && (data.limits || data.rate_limits)) || null;
  if (Array.isArray(list)) {
    for (const l of list) {
      if (!l) continue;
      const pct = typeof l.percent === 'number' ? l.percent
        : (l.limit && typeof l.limit.utilization === 'number') ? l.limit.utilization : null;
      if (pct == null) continue;
      const scopeName = l.scope && l.scope.model && l.scope.model.display_name;
      // La rama de arriba indexa SIN scope y esta indexaba CON scope, asi que
      // una entrada con scope nunca deduplicaba: salian dos barras identicas,
      // una con dolares y otra con severity. Se busca primero la clave base.
      const base = canonicalKey(l.kind);
      const key = byKey.has(base) ? base : canonicalKey(l.kind, scopeName);
      const existing = byKey.get(key);
      if (existing) {
        // ya lo teniamos del objeto: solo se le agrega lo que el array aporta
        existing.severity = l.severity || existing.severity;
        existing.isActive = !!l.is_active || existing.isActive;
        continue;
      }
      byKey.set(key, {
        key,
        label: scopeName ? `${etiqueta(key)} (${scopeName})` : etiqueta(key),
        utilization: pct,
        resetsAt: l.resets_at || (l.limit && l.limit.resets_at) || null,
        limitDollars: null, usedDollars: null, remainingDollars: null,
        lockedReason: null,
        severity: l.severity || null,
        isActive: !!l.is_active,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.utilization - a.utilization);
}

// Estado de los creditos de uso extra, que viaja en la misma respuesta.
function extraUsage(data) {
  const e = data && data.extra_usage;
  if (!e || typeof e !== 'object') return null;
  return {
    enabled: !!e.is_enabled,
    disabledReason: e.disabled_reason || null,
    utilization: typeof e.utilization === 'number' ? e.utilization : null,
    monthlyLimit: e.monthly_limit != null ? e.monthly_limit : null,
    usedCredits: e.used_credits != null ? e.used_credits : null,
    currency: e.currency || 'USD',
    everEnabled: !!e.credits_ever_enabled,
  };
}

async function consultar() {
  const creds = readCredentials();
  const res = await request(creds.token);

  if (res.status === 401 || res.status === 403) {
    throw new UsageError(
      'expired',
      'La API rechazo el token (' + res.status + '). Abri Claude Code para renovar la sesion.'
    );
  }
  if (res.status === 429) {
    // Retry-After puede venir en segundos o como fecha HTTP.
    const h = res.retryAfter;
    let esperaMs = ESPERA_429_POR_DEFECTO_MS;
    if (h) {
      const seg = Number(h);
      esperaMs = Number.isFinite(seg) ? seg * 1000 : Math.max(0, Date.parse(h) - Date.now());
      if (!Number.isFinite(esperaMs) || esperaMs <= 0) esperaMs = ESPERA_429_POR_DEFECTO_MS;
    }
    esperaMs = Math.min(esperaMs, ESPERA_429_MAXIMA_MS);
    bloqueadoHasta = Date.now() + esperaMs;
    // No se promete un reintento automatico: el auto-refresco viene apagado
    // por defecto, asi que en general el que reintenta es el usuario.
    throw new UsageError('rate-limit',
      'La API está limitando las consultas (429). Podés reintentar en ' +
      Math.ceil(esperaMs / 1000) + ' s.');
  }
  if (res.status !== 200) {
    throw new UsageError('http-' + res.status, 'La API respondio ' + res.status + '.');
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new UsageError('parse', 'La respuesta no era JSON valido.');
  }

  const meters = normalize(data);
  if (!meters.length) {
    // Se muestran solo las claves, nunca los valores: alcanza para diagnosticar
    // un cambio de formato sin volcar datos de la cuenta en pantalla.
    const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 12).join(', ') : typeof data;
    throw new UsageError(
      'shape',
      'La respuesta no traia medidores reconocibles (claves: ' + keys + '). ' +
      'Probablemente cambio el formato del endpoint.'
    );
  }
  return {
    fetchedAtMs: Date.now(),
    meters,
    extraUsage: extraUsage(data),
    source: 'vivo',
    tokenExpiresAt: creds.expiresAt,
  };
}

// Punto de entrada unico: todo el que quiera el uso en vivo pasa por aca.
// `forzar` salta el cache de MIN_INTERVALO (el boton lo usa), pero NO salta el
// bloqueo por 429 ni abre una segunda consulta si ya hay una en vuelo.
function fetchUsage({ forzar = false } = {}) {
  const ahora = Date.now();

  if (ahora < bloqueadoHasta) {
    if (ultima) return Promise.resolve({ ...ultima.data, source: 'cache', esperandoHasta: bloqueadoHasta });
    return Promise.reject(new UsageError('rate-limit',
      'La API está limitando las consultas. Probá de nuevo en ' +
      Math.ceil((bloqueadoHasta - ahora) / 1000) + ' s.'));
  }

  if (enVuelo) return enVuelo;

  if (!forzar && ultima && (ahora - ultima.at) < MIN_INTERVALO_MS) {
    return Promise.resolve({ ...ultima.data, source: 'cache' });
  }

  enVuelo = consultar()
    .then((data) => { ultima = { at: Date.now(), data }; return data; })
    .finally(() => { enVuelo = null; });
  return enVuelo;
}

// Para que la UI pueda decir "esperando" en vez de mostrar un error crudo.
function estado() {
  return {
    bloqueadoHasta: bloqueadoHasta > Date.now() ? bloqueadoHasta : null,
    ultimaConsultaMs: ultima ? ultima.at : null,
    minIntervaloMs: MIN_INTERVALO_MS,
  };
}

module.exports = { fetchUsage, estado, normalize, extraUsage, UsageError };
