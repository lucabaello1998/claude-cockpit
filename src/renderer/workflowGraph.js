// Lógica pura (sin React ni Electron) para el editor visual de workflows:
// generar código JS real a partir de un grafo de nodos, y leerlo de vuelta.
//
// El grafo se guarda embebido como comentario al FINAL del archivo generado,
// para no tapar el código legible al abrirlo en la pestaña "Código" o en un
// editor externo:
//
//   /* @cockpit-graph v1
//   {"v":1,"codeHash":123,"graph":{...}}
//   */
//
// Si ese comentario no está (workflow escrito a mano, o editado en la pestaña
// Código de forma que ya no coincide) no hay grafo editable: se reconstruye
// una aproximación de solo lectura a partir de `analizar()` (mismo dato que
// ya usa el Diagrama de hoy).

const MARKER = '/* @cockpit-graph v1';

// --- utilidades ---------------------------------------------------------

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

let idSeq = 1;
function nextId(prefix) {
  return prefix + '_' + idSeq++ + '_' + Math.random().toString(36).slice(2, 7);
}

function labelOf(n) {
  if (!n) return '';
  if (n.type === 'agent') return n.data?.label || 'agente';
  if (n.type === 'phase') return n.data?.title || 'etapa';
  if (n.type === 'group') return n.data?.label || 'grupo paralelo';
  if (n.type === 'note') return 'nota';
  if (n.type === 'return') return 'return';
  return n.type || '';
}

// --- fábricas de nodos (paleta → canvas) --------------------------------

function makeAgentNode(position) {
  return { id: nextId('agent'), type: 'agent', position, data: { label: 'agente', prompt: '', promptIsExpr: false, effort: '', schemaText: '' } };
}
function makeNoteNode(position) {
  return { id: nextId('note'), type: 'note', position, data: { text: '' } };
}
function makePhaseNode(position) {
  return { id: nextId('phase'), type: 'phase', position, data: { title: 'Etapa' } };
}
function makeGroupNode(position) {
  return { id: nextId('group'), type: 'group', position, data: { label: 'Grupo paralelo' }, style: { width: 280, height: 220 } };
}
function makeReturnNode(position) {
  return { id: nextId('return'), type: 'return', position, data: { expression: '{}' } };
}

const FACTORY = { agent: makeAgentNode, note: makeNoteNode, phase: makePhaseNode, group: makeGroupNode, return: makeReturnNode };
function makeNode(type, position) {
  const f = FACTORY[type];
  return f ? f(position) : null;
}

function emptyGraph() {
  return { version: 1, meta: { name: '', description: '', whenToUse: '' }, nodes: [], edges: [] };
}

// --- validación -----------------------------------------------------------

// Cadena "mejor esfuerzo": no tira error ante ciclos/ramas, corta a los 200
// pasos. Sirve solo para pistas en la UI (ej. variables disponibles para el
// Return), no para generar código — para eso está validateGraph + buildScriptBody.
function previewChain(graphDoc) {
  const nodes = graphDoc.nodes || [];
  const edges = graphDoc.edges || [];
  const childIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.id));
  const topLevel = nodes.filter((n) => !n.parentId);
  const byId = new Map(topLevel.map((n) => [n.id, n]));
  const out = new Map();
  const inn = new Set();
  for (const e of edges) {
    if (childIds.has(e.source) || childIds.has(e.target)) continue;
    if (!out.has(e.source)) out.set(e.source, e.target);
    inn.add(e.target);
  }
  const root = topLevel.find((n) => !inn.has(n.id));
  const chain = [];
  const seen = new Set();
  let cur = root;
  while (cur && !seen.has(cur.id) && chain.length < 200) {
    seen.add(cur.id);
    chain.push(cur);
    const nid = out.get(cur.id);
    cur = nid ? byId.get(nid) : null;
  }
  return chain;
}

function validateGraph(graphDoc) {
  const errors = [];
  const warnings = [];
  const nodes = graphDoc.nodes || [];
  const edges = graphDoc.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const n of nodes) {
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    if (!parent || parent.type !== 'group') errors.push(`El nodo "${labelOf(n)}" quedó apuntando a un grupo que no existe.`);
    else if (n.type !== 'agent') errors.push('Los grupos paralelos solo pueden contener nodos de tipo Agente.');
  }

  const childIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.id));
  for (const e of edges) {
    if (childIds.has(e.source) || childIds.has(e.target)) {
      errors.push('No se puede conectar una flecha directamente a un agente que está dentro de un grupo.');
      break;
    }
  }

  const topLevel = nodes.filter((n) => !n.parentId);
  if (!topLevel.length) return { ok: false, errors: ['El diagrama está vacío.'], warnings, chain: [] };

  const out = new Map();
  const inn = new Map();
  for (const e of edges) {
    if (childIds.has(e.source) || childIds.has(e.target)) continue;
    (out.get(e.source) || out.set(e.source, []).get(e.source)).push(e.target);
    (inn.get(e.target) || inn.set(e.target, []).get(e.target)).push(e.source);
  }
  for (const n of topLevel) {
    if ((out.get(n.id) || []).length > 1) errors.push(`"${labelOf(n)}" tiene más de una flecha saliendo: en esta versión no se permiten ramas.`);
    if ((inn.get(n.id) || []).length > 1) errors.push(`"${labelOf(n)}" tiene más de una flecha entrando: en esta versión no se permiten uniones.`);
  }

  const roots = topLevel.filter((n) => !(inn.get(n.id) || []).length);
  if (!roots.length) errors.push('No se encontró un nodo inicial: puede haber un ciclo.');
  if (roots.length > 1) errors.push('Hay más de un punto de partida: conectá todos los nodos en una sola cadena.');

  let chain = [];
  if (roots.length === 1) {
    const visited = new Set();
    let cur = roots[0];
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      chain.push(cur);
      const nexts = out.get(cur.id) || [];
      cur = nexts.length ? byId.get(nexts[0]) : null;
    }
    if (cur) errors.push('Hay un ciclo en la cadena de nodos.');
    const unreached = topLevel.filter((n) => !visited.has(n.id));
    if (unreached.length) warnings.push(`${unreached.length} nodo(s) sueltos, no conectados a la cadena principal: no se van a incluir.`);
  }

  const last = chain[chain.length - 1];
  if (!chain.length || !last || last.type !== 'return') errors.push('El diagrama tiene que terminar en un nodo Return.');
  if (chain.slice(0, -1).some((n) => n.type === 'return')) errors.push('El nodo Return tiene que ser el último de la cadena.');

  for (const n of nodes) {
    if (n.type !== 'group') continue;
    if (!nodes.some((c) => c.parentId === n.id)) errors.push(`El grupo "${labelOf(n)}" está vacío.`);
  }

  if (chain.length && chain[0].type === 'agent' && /\{\{prev\}\}/.test(chain[0].data?.prompt || '')) {
    errors.push('El primer nodo de la cadena no puede usar {{prev}}: todavía no hay un resultado anterior.');
  }

  return { ok: errors.length === 0, errors, warnings, chain };
}

// --- codegen: grafo → texto de prompt/expresión ----------------------------

function buildTextExpr(text, { prevVar, prevHasSchema }, isExpr) {
  if (isExpr) return text && text.trim() ? text.trim() : "''";
  if (!text) return "''";
  const parts = text.split(/(\{\{prev\}\}|\{\{args\}\})/g).filter((s) => s !== '');
  const exprParts = parts.map((seg) => {
    if (seg === '{{prev}}') {
      if (!prevVar) throw new Error('{{prev}} usado sin un paso anterior.');
      return prevHasSchema ? `JSON.stringify(${prevVar})` : prevVar;
    }
    if (seg === '{{args}}') return 'args';
    return JSON.stringify(seg);
  });
  return exprParts.length ? exprParts.join(' + ') : "''";
}

// --- codegen: grafo → cuerpo del script ------------------------------------

function buildScriptBody(graphDoc) {
  const check = validateGraph(graphDoc);
  if (!check.ok) throw new Error('Grafo inválido:\n- ' + check.errors.join('\n- '));
  const { chain } = check;
  const nodes = graphDoc.nodes || [];
  const meta = graphDoc.meta || {};

  const phaseTitles = chain.filter((n) => n.type === 'phase').map((n) => n.data.title || '');
  const metaLines = [
    `  name: ${JSON.stringify(meta.name || '')},`,
    `  description: ${JSON.stringify(meta.description || '')},`,
  ];
  if (meta.whenToUse) metaLines.push(`  whenToUse: ${JSON.stringify(meta.whenToUse)},`);
  if (phaseTitles.length) metaLines.push(`  phases: [${phaseTitles.map((t) => `{ title: ${JSON.stringify(t)} }`).join(', ')}],`);

  const lines = [`export const meta = {\n${metaLines.join('\n')}\n}`, ''];

  let varCounter = 1;
  let prevVar = null;
  let prevHasSchema = false;
  let currentPhaseTitle = null;

  for (const node of chain) {
    if (node.type === 'phase') {
      currentPhaseTitle = node.data.title || '';
      lines.push(`phase(${JSON.stringify(currentPhaseTitle)})`);
      continue;
    }
    if (node.type === 'note') {
      for (const l of (node.data.text || '').split('\n')) lines.push('// ' + l);
      continue;
    }
    if (node.type === 'agent') {
      const promptExpr = buildTextExpr(node.data.prompt || '', { prevVar, prevHasSchema }, !!node.data.promptIsExpr);
      const opts = [`label: ${JSON.stringify(node.data.label || 'agente')}`];
      if (node.data.effort) opts.push(`effort: ${JSON.stringify(node.data.effort)}`);
      const hasSchema = !!(node.data.schemaText && node.data.schemaText.trim());
      if (hasSchema) opts.push(`schema: ${node.data.schemaText.trim()}`);
      const varName = 'r' + varCounter++;
      lines.push(`const ${varName} = await agent(${promptExpr}, { ${opts.join(', ')} })`);
      prevVar = varName;
      prevHasSchema = hasSchema;
      continue;
    }
    if (node.type === 'group') {
      const children = nodes.filter((c) => c.parentId === node.id).sort((a, b) => a.position.y - b.position.y);
      const childLines = children.map((c) => {
        const promptExpr = buildTextExpr(c.data.prompt || '', { prevVar, prevHasSchema }, !!c.data.promptIsExpr);
        const opts = [`label: ${JSON.stringify(c.data.label || 'agente')}`];
        if (currentPhaseTitle) opts.push(`phase: ${JSON.stringify(currentPhaseTitle)}`);
        if (c.data.effort) opts.push(`effort: ${JSON.stringify(c.data.effort)}`);
        if (c.data.schemaText && c.data.schemaText.trim()) opts.push(`schema: ${c.data.schemaText.trim()}`);
        return `  () => agent(${promptExpr}, { ${opts.join(', ')} })`;
      });
      const varName = 'r' + varCounter++;
      lines.push(`const ${varName} = await parallel([\n${childLines.join(',\n')}\n])`);
      prevVar = varName;
      prevHasSchema = false;
      continue;
    }
    if (node.type === 'return') {
      const expr = node.data.expression && node.data.expression.trim() ? node.data.expression.trim() : '{}';
      lines.push(`return ${expr}`);
    }
  }

  return lines.join('\n');
}

// --- embebido / extracción del grafo en el archivo -------------------------

function embedGraph(codeBody, graphDoc) {
  const codeHash = hashCode(codeBody);
  const payload = { v: 1, codeHash, graph: graphDoc };
  // Un prompt que contenga literalmente "*/" no puede cortar el comentario:
  // "*\/" es un escape JSON válido para "/" y JSON.parse lo deshace solo.
  const json = JSON.stringify(payload).replace(/\*\//g, '*\\/');
  return codeBody + '\n' + MARKER + '\n' + json + '\n*/\n';
}

function generateSource(graphDoc) {
  const codeBody = buildScriptBody(graphDoc).replace(/\s+$/, '') + '\n';
  return embedGraph(codeBody, graphDoc);
}

function extractGraph(src) {
  if (typeof src !== 'string') return null;
  const i = src.lastIndexOf(MARKER);
  if (i < 0) return null;
  const start = i + MARKER.length;
  const end = src.indexOf('*/', start);
  if (end < 0) return null;
  try {
    const payload = JSON.parse(src.slice(start, end).trim());
    if (!payload || !payload.graph) return null;
    return payload;
  } catch {
    return null;
  }
}

function stripEmbeddedGraph(src) {
  const i = src.lastIndexOf(MARKER);
  if (i < 0) return src;
  const end = src.indexOf('*/', i);
  if (end < 0) return src;
  const before = src.slice(0, i).replace(/\n+$/, '\n');
  const after = src.slice(end + 2).replace(/^\s+/, '');
  return after ? before + '\n' + after : before;
}

// Se llama antes de escribir lo que sea que haya en la pestaña "Código".
// Si el grafo embebido ya no corresponde al código (se editó a mano), se
// descarta en vez de guardar un grafo desincronizado con el archivo real.
function reconcileBeforeSave(content) {
  const extracted = extractGraph(content);
  if (!extracted) return { content, graphDropped: false };
  const body = stripEmbeddedGraph(content);
  if (hashCode(body) === extracted.codeHash) return { content, graphDropped: false };
  return { content: body, graphDropped: true };
}

// --- reconstrucción de solo lectura a partir del análisis estático ---------

// No se inventan nodos "group": la etiqueta `concurrencia` de analizar() es
// "región más cercana que lo contiene", no un límite exacto de agrupación —
// agruparlos igual mostraría algo que no está garantizado que sea cierto.
function fromAnalysis(analisis) {
  const nodes = [];
  const edges = [];
  let x = 0;
  let prevId = null;
  const fases = (analisis?.fases || []).filter((f) => f.agentes.length || f.usada || f.declarada);
  for (const fase of fases) {
    const phaseId = nextId('ro_phase');
    nodes.push({ id: phaseId, type: 'phase', position: { x, y: 0 }, data: { title: fase.titulo }, readOnly: true });
    if (prevId) edges.push({ id: prevId + '>' + phaseId, source: prevId, target: phaseId });
    prevId = phaseId;
    let y = 90;
    for (const ag of fase.agentes) {
      const agId = nextId('ro_agent');
      nodes.push({
        id: agId, type: 'agent', position: { x, y }, readOnly: true,
        data: { label: ag.label, effort: ag.effort, tieneSchema: ag.tieneSchema, concurrencia: ag.concurrencia, linea: ag.linea, readOnly: true },
      });
      edges.push({ id: prevId + '>' + agId, source: prevId, target: agId });
      prevId = agId;
      y += 90;
    }
    x += 240;
  }
  // Un análisis sin nada adentro (archivo nuevo, todavía sin guardar) no tiene
  // nada que aproximar ni nada que se pueda pisar por error: arranca editable
  // de una, en vez de obligar a pasar por "Empezar un diagrama nuevo".
  const hayAlgo = !!(analisis?.tieneMeta || (analisis?.agentes && analisis.agentes.length));

  return {
    version: 1,
    readOnly: hayAlgo,
    usaPipeline: !!analisis?.usaPipeline,
    meta: { name: analisis?.name || '', description: analisis?.description || '', whenToUse: analisis?.whenToUse || '' },
    nodes,
    edges,
  };
}

// Misma forma que devuelve analizar('') en workflowsEdit.cjs (main process,
// no importable desde el renderer) — para poder abrir un workflow nuevo sin
// guardar todavía sin duplicar la lógica de análisis en dos lugares.
function analisisVacio() {
  return {
    name: null, description: null, whenToUse: null, tieneMeta: false,
    fases: [], agentes: [], sinFase: 0, usaParallel: false, usaPipeline: false, usaArgs: false, lineas: 1,
  };
}

export {
  emptyGraph, makeNode, makeAgentNode, makeNoteNode, makePhaseNode, makeGroupNode, makeReturnNode,
  labelOf, previewChain, validateGraph, buildTextExpr, buildScriptBody,
  embedGraph, generateSource, extractGraph, stripEmbeddedGraph, reconcileBeforeSave,
  fromAnalysis, analisisVacio, hashCode,
};
