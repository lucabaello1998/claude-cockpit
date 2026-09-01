'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { P, readJSON } = require('./sources/paths.cjs');

// El repaso del día.
//
// La idea original era pedirle los consejos a un modelo, pero casi nada de lo
// que hace falta necesita uno: "en qué se te va la plata", "qué configuraste y
// nunca usás", "qué tenés sin cerrar" y "qué cambió en Claude Code desde tu
// versión" salen de datos que la app ya tiene o que se leen de una URL pública.
//
// Asi que esto NO gasta tokens. Cada consejo sale de una regla concreta sobre
// tus propios numeros, y ninguna dispara si no tiene algo real que decir: un
// panel que siempre encuentra seis cosas para decirte se vuelve ruido y dejas
// de leerlo.

const CHANGELOG = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const DIA_MS = 86400000;

// El changelog pesa ~588 KB y solo cambia cuando sale una version de Claude
// Code. Bajarlo entero una vez por dia es tirar ancho de banda: GitHub manda
// ETag y responde 304 con CERO bytes si no cambio nada. Medido: 588 KB -> 0.
function pedirTexto(url, etag) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'claude-cockpit/1.0' };
    if (etag) headers['If-None-Match'] = etag;
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      if (res.statusCode === 304) { res.resume(); return resolve({ sinCambios: true }); }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ texto: b, etag: res.headers.etag || null }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// "2.1.252" -> [2,1,252]. Lo que no parsea queda en null y no se compara.
function version(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function masNueva(a, b) {
  const x = version(a); const y = version(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

// --- novedades ---------------------------------------------------------------

// Que salio en Claude Code desde la version que estas usando. Es lo mas util
// que se puede decir sin inventar nada: sale del changelog oficial y se filtra
// contra TU version, no contra la ultima.
// `previo` es lo que quedo guardado del repaso anterior: si el changelog no
// cambio, se reusa sin volver a bajarlo. La version del usuario SI puede haber
// cambiado, asi que el filtrado se recalcula siempre sobre los bloques
// guardados.
async function novedades(versionActual, previo) {
  const etagPrevio = previo && previo.etag;
  const r = await pedirTexto(CHANGELOG, etagPrevio);
  if (!r) return null;

  if (r.sinCambios && previo && Array.isArray(previo.bloques)) {
    return armarNovedades(previo.bloques, versionActual, etagPrevio);
  }

  const md = r.texto;
  if (!md) return null;

  const bloques = [];
  let actual = null;
  for (const linea of md.split(/\r?\n/)) {
    const cab = /^##\s+(\d+\.\d+\.\d+)/.exec(linea);
    if (cab) {
      actual = { version: cab[1], entradas: [] };
      bloques.push(actual);
      if (bloques.length > 40) break;   // no hace falta leer 574 KB de historia
      continue;
    }
    if (!actual) continue;
    const it = /^[-*]\s+(.+)$/.exec(linea.trim());
    if (it) actual.entradas.push(it[1].trim());
  }
  if (!bloques.length) return null;
  return armarNovedades(bloques, versionActual, r.etag);
}

function armarNovedades(bloques, versionActual, etag) {
  const nuevas = versionActual
    ? bloques.filter((b) => masNueva(b.version, versionActual))
    : bloques.slice(0, 1);

  return {
    ultima: bloques[0].version,
    tuya: versionActual || null,
    versionesNuevas: nuevas.length,
    // Lo mas jugoso primero: lo que agrega cosas nuevas antes que los arreglos.
    destacado: nuevas
      .flatMap((b) => b.entradas.map((e) => ({ version: b.version, texto: e })))
      .sort((a, b) => {
        const nuevoA = /^Added|^New /i.test(a.texto) ? 0 : 1;
        const nuevoB = /^Added|^New /i.test(b.texto) ? 0 : 1;
        return nuevoA - nuevoB;
      })
      .slice(0, 6),
    // Lo que hace falta para no volver a bajar el changelog la proxima vez.
    etag: etag || null,
    bloques,
  };
}

// --- reglas sobre tus propios numeros ---------------------------------------

const fmtUSD = (n) => '$' + (Number(n) || 0).toFixed(2);
const pct = (n) => Math.round(n * 100) + '%';

function consejosDeUso(snap) {
  const out = [];
  const p7 = (snap.periods || {}).d7;
  const p14 = (snap.periods || {}).d14;
  if (!p7 || !p7.totals.requests) return out;
  const t = p7.totals;

  // Cuanto te esta ahorrando la cache. Es plata que NO gastaste, y casi nadie
  // la mira.
  const ahorro = (t.costNoCacheUSD || 0) - (t.costUSD || 0);
  if (ahorro > 1) {
    const tasa = t.totalTokens ? t.cacheRead / t.totalTokens : 0;
    out.push({
      id: 'cache',
      categoria: 'eficiencia',
      titulo: 'La caché te ahorró ' + fmtUSD(ahorro) + ' esta semana',
      texto: `El ${pct(tasa)} de tus tokens salieron de caché en vez de re-enviarse. ` +
        'Se aprovecha sola cuando seguís en la misma sesión: abrir una nueva para cada consulta la tira a la basura.',
    });
  }

  // Como viene el costo por consulta tuya contra la semana pasada. p14 incluye
  // a p7, asi que la semana anterior es la resta.
  if (p14 && p14.userTurns > p7.userTurns) {
    const previaCosto = (p14.totals.costUSD || 0) - (t.costUSD || 0);
    const previaTurnos = p14.userTurns - p7.userTurns;
    const ahora = p7.userTurns ? t.costUSD / p7.userTurns : 0;
    const antes = previaTurnos ? previaCosto / previaTurnos : 0;
    if (antes > 0.5 && ahora > 0.5) {
      const cambio = (ahora - antes) / antes;
      if (Math.abs(cambio) > 0.25) {
        out.push({
          id: 'tendencia',
          categoria: 'eficiencia',
          titulo: cambio > 0
            ? `Tus consultas están saliendo ${pct(cambio)} más caras que la semana pasada`
            : `Tus consultas están saliendo ${pct(-cambio)} más baratas que la semana pasada`,
          texto: `Pasaste de ${fmtUSD(antes)} a ${fmtUSD(ahora)} por consulta tuya. ` +
            (cambio > 0
              ? 'Suele pasar cuando las sesiones se hacen largas: cada mensaje arrastra todo el contexto anterior. Cerrar y abrir de nuevo al cambiar de tema lo corta.'
              : 'Algo estás haciendo mejor: sesiones más cortas o más aprovechamiento de caché.'),
        });
      }
    }
  }

  // Si todo va a Opus, decirlo. No es un reto: es que muchas tareas no lo
  // necesitan y la diferencia de precio es grande.
  const modelos = p7.byModel || [];
  const total = modelos.reduce((a, m) => a + (m.costUSD || 0), 0);
  const opus = modelos.filter((m) => /opus/i.test(m.label)).reduce((a, m) => a + (m.costUSD || 0), 0);
  if (total > 5 && opus / total > 0.9 && modelos.length > 0) {
    out.push({
      id: 'modelos',
      categoria: 'eficiencia',
      titulo: 'Casi todo tu gasto es Opus',
      texto: `El ${pct(opus / total)} de lo que gastaste esta semana fue con Opus. ` +
        'Para leer archivos, buscar cosas o correr comandos, Sonnet hace lo mismo por mucho menos. ' +
        'Se cambia con /model, y podés volver a Opus para lo que sí lo necesite.',
    });
  }

  return out;
}

function consejosDeSetup(snap) {
  const out = [];
  const cfg = snap.config || {};
  const settings = cfg.settings || {};
  const byTool = snap.byTool || {};

  // Hooks: la app trae plantillas listas, asi que la sugerencia es concreta.
  const reglasHooks = Object.values(settings.hooks || {}).reduce((a, v) => a + (v || []).length, 0);
  if (!reglasHooks) {
    const escrituras = (byTool.Write || 0) + (byTool.Edit || 0);
    if (escrituras > 50) {
      out.push({
        id: 'hooks',
        categoria: 'setup',
        titulo: 'No tenés ningún hook, y editás mucho',
        texto: `Claude tocó archivos ${escrituras} veces. Un hook de PostToolUse puede formatear cada archivo al guardarlo, ` +
          'o correr los tests y avisarte si algo se rompió. En Configuración → Hooks hay plantillas listas para eso.',
        ir: 'hooks',
      });
    }
  }

  // Workflows: si nunca armaste uno y usás subagentes, vale la pena.
  const workflows = (cfg.workflows || []).length;
  if (!workflows && (snap.counts || {}).subagentTranscripts > 20) {
    out.push({
      id: 'workflows',
      categoria: 'setup',
      titulo: 'Usás subagentes pero no tenés workflows guardados',
      texto: `Se lanzaron ${snap.counts.subagentTranscripts} subagentes en tus sesiones. ` +
        'Un workflow guarda esa orquestación para repetirla sin re-explicarla cada vez. ' +
        'En Configuración → Workflows hay un tutorial y ejemplos que se pueden correr.',
      ir: 'workflows',
    });
  }

  // Proyectos que nunca se indexaron en el grafo.
  const proyectos = (cfg.projects || []).length;
  if (proyectos > 2) {
    let indexados = 0;
    try {
      const graph = require('./mcpGraph.cjs');
      if (!graph.available()) {
        out.push({
          id: 'grafo',
          categoria: 'setup',
          titulo: 'Tenés ' + proyectos + ' proyectos y ningún grafo de código',
          texto: 'Con un servidor de grafo indexado, Claude encuentra dónde está definida una función o quién la llama ' +
            'sin leer medio repo a mano. Está en Configuración → Requisitos.',
          ir: 'requisitos',
        });
      }
    } catch { /* sin modulo, sin consejo */ }
    void indexados;
  }

  return out;
}

// --- pendientes --------------------------------------------------------------

// Lo que tenés empezado y sin cerrar. Sale de tus tableros, no de adivinar.
async function pendientes(boardsDir) {
  const out = [];

  // Azure DevOps: lo tuyo, quieto hace rato.
  try {
    const ado = require('./ado.cjs');
    const conn = ado.conexion();
    if (conn && conn.conectado) {
      const proyectos = await ado.proyectos();
      // Se mira solo el primero para no hacer una consulta por proyecto: el
      // repaso tiene que ser rapido, no exhaustivo.
      const pr = proyectos[0];
      if (pr) {
        const eqs = await ado.equipos(pr.name);
        const t = await ado.tablero(pr.name, eqs[0] && eqs[0].name, { soloMias: true });
        const abiertas = t.tarjetas.filter((x) => !/done|closed|finalizado|removed/i.test(x.columna));
        const quietas = abiertas.filter((x) => x.modificado &&
          (Date.now() - Date.parse(x.modificado)) > 14 * DIA_MS);
        if (quietas.length) {
          out.push({
            id: 'ado-quietas',
            categoria: 'pendientes',
            titulo: `Tenés ${quietas.length} work item${quietas.length > 1 ? 's' : ''} tuyo${quietas.length > 1 ? 's' : ''} sin tocar hace más de dos semanas`,
            texto: quietas.slice(0, 4).map((x) => `#${x.id} ${x.titulo}`).join(' · ') +
              (quietas.length > 4 ? ` … y ${quietas.length - 4} más` : ''),
            ir: 'boards',
          });
        }

        // Sprint que se termina con cosas abiertas.
        const sps = await ado.sprints(pr.name, eqs[0] && eqs[0].name);
        const actual = sps.find((x) => x.estado === 'actual');
        if (actual && actual.hasta) {
          const faltan = Math.ceil((Date.parse(actual.hasta) - Date.now()) / DIA_MS);
          const enSprint = abiertas.filter((x) => x.sprintPath && x.sprintPath.endsWith(actual.nombre));
          if (faltan >= 0 && faltan <= 5 && enSprint.length) {
            out.push({
              id: 'sprint',
              categoria: 'pendientes',
              titulo: `${actual.nombre} termina en ${faltan === 0 ? 'hoy' : faltan + ' día' + (faltan > 1 ? 's' : '')} y tenés ${enSprint.length} sin cerrar`,
              texto: enSprint.slice(0, 4).map((x) => `#${x.id} ${x.titulo}`).join(' · '),
              ir: 'boards',
            });
          }
        }
      }
    }
  } catch { /* si ADO no responde, el repaso sigue sin eso */ }

  // Tableros propios: tarjetas quietas fuera de la ultima columna.
  try {
    const boards = require('./boards.cjs');
    for (const b of boards.listarLocales(boardsDir)) {
      const full = boards.obtenerLocal(boardsDir, b.id);
      if (!full) continue;
      const ultima = full.columnas[full.columnas.length - 1];
      const quietas = (full.tarjetas || []).filter((t) => t.columna !== (ultima && ultima.id)
        && t.actualizado && (Date.now() - Date.parse(t.actualizado)) > 7 * DIA_MS);
      if (quietas.length) {
        out.push({
          id: 'local-' + b.id,
          categoria: 'pendientes',
          titulo: `"${full.nombre}": ${quietas.length} tarjeta${quietas.length > 1 ? 's' : ''} sin mover hace más de una semana`,
          texto: quietas.slice(0, 4).map((t) => t.titulo).join(' · '),
          ir: 'boards',
        });
      }
    }
  } catch { /* sin tableros propios */ }

  return out;
}

// --- armado ------------------------------------------------------------------

function archivo(userDataDir) { return path.join(userDataDir, 'repaso.json'); }

function hoy() { return new Date().toISOString().slice(0, 10); }

async function generar(snap, userDataDir, boardsDir, previo) {
  const items = [];
  items.push(...consejosDeUso(snap));
  items.push(...consejosDeSetup(snap));
  items.push(...(await pendientes(boardsDir)));

  const versionActual = (snap.sessions || []).map((s) => s.version).filter(Boolean)[0] || null;
  let nov = null;
  try {
    nov = await novedades(versionActual, previo && previo.novedades);
  } catch { /* sin internet, sin novedades */ }

  const repaso = { fecha: hoy(), generadoMs: Date.now(), items, novedades: nov };
  try { fs.writeFileSync(archivo(userDataDir), JSON.stringify(repaso, null, 2)); }
  catch { /* si no se puede guardar, igual se muestra */ }
  return repaso;
}

// Se genera una vez por dia. `forzar` es para el boton de actualizar.
async function obtener(snap, userDataDir, boardsDir, forzar) {
  const guardado = readJSON(archivo(userDataDir), null);
  if (!forzar && guardado && guardado.fecha === hoy()) {
    return { ...guardado, deCache: true };
  }
  // Aunque toque regenerar, el ETag del changelog guardado sirve para no
  // volver a bajar 588 KB si no cambio nada.
  return generar(snap, userDataDir, boardsDir, guardado);
}

module.exports = { obtener, generar, novedades, version, masNueva, consejosDeUso, consejosDeSetup };
