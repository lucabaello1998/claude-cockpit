'use strict';
const fs = require('fs');
const path = require('path');
const { P, listDir, statSafe } = require('./sources/paths.cjs');
const seguro = require('./safePaths.cjs');

// Workflows: scripts en ~/.claude/workflows/*.js que orquestan subagentes.
//
// La API que usan (la documenta la skill `workflow-authoring`):
//   export const meta = { name, description, phases: [{ title }] }
//   phase('Titulo')                      marca en que etapa esta
//   agent(prompt, { label, phase, schema, effort })
//   parallel([fn, fn, ...])              corre en paralelo, espera a todos
//   pipeline(items, mapFn, thenFn)       encadena: cada item sigue apenas puede
//   args                                 lo que se le pasa al invocarlo
//
// El diagrama sale de LEER el codigo, no de ejecutarlo: es analisis estatico.
// Si el workflow arma los agentes de forma dinamica, el dibujo va a mostrar
// menos de lo que realmente corre. Se avisa en la interfaz.

function archivos() {
  return listDir(P.workflows)
    .filter((f) => f.isFile() && /\.[jt]s$/.test(f.name))
    .map((f) => {
      const full = path.join(P.workflows, f.name);
      const st = statSafe(full);
      return { file: f.name, path: full, bytes: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
    });
}

// --- parseo del meta ---------------------------------------------------------

function bloqueMeta(src) {
  const i = src.indexOf('export const meta');
  if (i < 0) return null;
  const abre = src.indexOf('{', i);
  if (abre < 0) return null;
  let nivel = 0;
  for (let j = abre; j < src.length; j++) {
    if (src[j] === '{') nivel++;
    else if (src[j] === '}') {
      nivel--;
      if (nivel === 0) return src.slice(abre, j + 1);
    }
  }
  return null;
}

function campo(bloque, nombre) {
  const m = new RegExp(nombre + "\\s*:\\s*(['\"`])([\\s\\S]*?)\\1").exec(bloque || '');
  return m ? m[2] : null;
}

function fasesDeclaradas(bloque) {
  if (!bloque) return [];
  const m = /phases\s*:\s*\[([\s\S]*?)\]/.exec(bloque);
  if (!m) return [];
  return [...m[1].matchAll(/title\s*:\s*(['"`])([\s\S]*?)\1/g)].map((x) => x[2]);
}

// --- parseo de la estructura para el diagrama --------------------------------

// Devuelve la etapa activa en cada posicion del archivo, segun las llamadas a
// phase() que aparecieron antes.
function faseEn(src, pos, llamadas) {
  let actual = null;
  for (const c of llamadas) {
    if (c.pos > pos) break;
    actual = c.titulo;
  }
  return actual;
}

function opcion(texto, nombre) {
  const m = new RegExp(nombre + "\\s*:\\s*(['\"`])([\\s\\S]*?)\\1").exec(texto || '');
  return m ? m[2] : null;
}

// Toma el fragmento que sigue a `agent(` hasta cerrar el parentesis, contando
// niveles para no cortar en una coma interna.
function argumentosDe(src, desde) {
  let nivel = 0;
  for (let j = desde; j < src.length && j < desde + 4000; j++) {
    const ch = src[j];
    if (ch === '(') nivel++;
    else if (ch === ')') {
      nivel--;
      if (nivel === 0) return src.slice(desde, j + 1);
    }
  }
  return src.slice(desde, desde + 400);
}

function analizar(src) {
  const meta = bloqueMeta(src);
  const llamadasFase = [...src.matchAll(/(?:^|[^\w.])phase\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g)]
    .map((m) => ({ pos: m.index, titulo: m[2] }));

  // Region que abarca cada parallel()/pipeline(): mirar hacia atras con una
  // expresion regular no sirve porque el envoltorio puede estar muchas lineas
  // arriba. Se calcula el parentesis de cierre real y despues se pregunta si la
  // llamada a agent() cae adentro.
  const regiones = [];
  for (const m of src.matchAll(/(?:^|[^\w.])(parallel|pipeline)\s*\(/g)) {
    const abre = m.index + m[0].length - 1;
    let nivel = 0;
    for (let j = abre; j < src.length; j++) {
      if (src[j] === '(') nivel++;
      else if (src[j] === ')') {
        nivel--;
        if (nivel === 0) { regiones.push({ tipo: m[1], desde: abre, hasta: j }); break; }
      }
    }
  }
  const concurrenciaEn = (pos) => {
    // La region mas chica que lo contenga es la que manda (puede haber anidados).
    let mejor = null;
    for (const r of regiones) {
      if (pos > r.desde && pos < r.hasta) {
        if (!mejor || (r.hasta - r.desde) < (mejor.hasta - mejor.desde)) mejor = r;
      }
    }
    return mejor ? mejor.tipo : 'secuencial';
  };

  const agentes = [];
  for (const m of src.matchAll(/(?:^|[^\w.])agent\s*\(/g)) {
    const inicio = m.index + m[0].length - 1;
    const args = argumentosDe(src, inicio);
    agentes.push({
      // Un label armado por concatenacion ('do-' + i) se lee incompleto:
      // se marca con * para no mentir sobre el nombre real.
      label: (() => {
        const l = opcion(args, 'label');
        if (!l) return 'agente';
        return /label\s*:\s*(['"`])[\s\S]*?\1\s*\+/.test(args) ? l + '*' : l;
      })(),
      fase: opcion(args, 'phase') || faseEn(src, m.index, llamadasFase),
      effort: opcion(args, 'effort'),
      tieneSchema: /schema\s*:/.test(args),
      concurrencia: concurrenciaEn(m.index),
      linea: src.slice(0, m.index).split('\n').length,
    });
  }

  // Las etapas del diagrama: las declaradas en meta, mas las que aparezcan solo
  // en el codigo, en el orden en que se usan.
  const declaradas = fasesDeclaradas(meta);
  const usadas = [...new Set(llamadasFase.map((c) => c.titulo))];
  const fases = [...declaradas];
  for (const u of usadas) if (!fases.includes(u)) fases.push(u);
  const sinFase = agentes.filter((a) => !a.fase).length;

  return {
    name: campo(meta, 'name'),
    description: campo(meta, 'description'),
    whenToUse: campo(meta, 'whenToUse'),
    tieneMeta: !!meta,
    fases: fases.map((f) => ({
      titulo: f,
      declarada: declaradas.includes(f),
      usada: usadas.includes(f),
      agentes: agentes.filter((a) => a.fase === f),
    })),
    agentes,
    sinFase,
    usaParallel: /\bparallel\s*\(/.test(src),
    usaPipeline: /\bpipeline\s*\(/.test(src),
    usaArgs: /\bargs\b/.test(src),
    lineas: src.split('\n').length,
  };
}

// --- lectura y escritura -----------------------------------------------------

function list() {
  return archivos().map((a) => {
    let src = '';
    try { src = fs.readFileSync(a.path, 'utf8'); } catch { /* ilegible */ }
    const an = analizar(src);
    return Object.assign(a, {
      name: an.name || a.file.replace(/\.[jt]s$/, ''),
      description: an.description,
      fases: an.fases.length,
      agentes: an.agentes.length,
      tieneMeta: an.tieneMeta,
    });
  });
}

function leer(nombre) {
  const file = seguro.unirSeguro(P.workflows, nombre);
  if (!file || !statSafe(file)) throw new Error('No existe ese workflow.');
  const src = fs.readFileSync(file, 'utf8');
  return { file: nombre, path: file, content: src, analisis: analizar(src) };
}

function guardar(nombre, contenido) {
  const file = seguro.unirSeguro(P.workflows, nombre);
  if (!file) throw new Error('Nombre de archivo inválido.');
  if (!/\.[jt]s$/.test(nombre)) throw new Error('El archivo tiene que terminar en .js');
  const an = analizar(contenido);
  if (!an.tieneMeta) throw new Error('Falta el bloque "export const meta = { ... }".');
  if (!an.name) throw new Error('El meta tiene que declarar un "name".');
  fs.mkdirSync(P.workflows, { recursive: true });
  // Mismo cuidado que con los hooks: un enlace simbolico dentro de workflows/
  // podria desviar la escritura fuera de ~/.claude.
  if (!seguro.destinoRealSeguro(P.workflows, file)) {
    throw new Error('Ese destino sale de ~/.claude/workflows (¿es un enlace simbólico?).');
  }
  if (statSafe(file)) fs.writeFileSync(file + '.bak', fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, contenido);
  return leer(nombre);
}

function borrar(nombre) {
  const file = seguro.unirSeguro(P.workflows, nombre);
  if (!file || !seguro.dentroDe(P.workflows, file)) throw new Error('Solo se borran workflows de ~/.claude/workflows.');
  fs.rmSync(file, { force: true });
  return { file: nombre };
}

module.exports = { list, leer, guardar, borrar, analizar, dir: P.workflows };
