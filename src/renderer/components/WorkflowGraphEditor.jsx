import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  Handle, Position, useNodesState, useEdgesState, useReactFlow, addEdge,
  applyNodeChanges, applyEdgeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  makeNode, labelOf, previewChain, validateGraph, generateSource, extractGraph, fromAnalysis,
} from '../workflowGraph.js';

// Editor visual de workflows: arrastrar componentes de la paleta al canvas,
// conectarlos, y generar el código real (agent()/parallel()/phase()) a partir
// de eso. Si el archivo abierto no tiene un grafo embebido (fue escrito a
// mano, o se editó en la pestaña Código de forma que ya no coincide), se
// muestra una reconstrucción de solo lectura hecha a partir de analizar().

const PALETTE = [
  { type: 'agent', label: 'Agente', hint: 'Un subagente con su propio prompt.' },
  { type: 'note', label: 'Nota / instrucción', hint: 'Comentario libre, no ejecuta nada.' },
  { type: 'group', label: 'Grupo paralelo', hint: 'Varios agentes que corren juntos (parallel).' },
  { type: 'phase', label: 'Etapa', hint: 'Marca el inicio de una fase (phase()).' },
  { type: 'return', label: 'Return', hint: 'Lo que devuelve el workflow al terminar.' },
];

function pointInNode(pos, n) {
  const w = (n.style && n.style.width) || (n.measured && n.measured.width) || 260;
  const h = (n.style && n.style.height) || (n.measured && n.measured.height) || 200;
  return pos.x >= n.position.x && pos.x <= n.position.x + w && pos.y >= n.position.y && pos.y <= n.position.y + h;
}

// --- nodos custom -----------------------------------------------------------

function PhaseNode({ data, selected }) {
  return (
    <div className={'wfnode wfnode-phase' + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} />
      <b style={{ fontSize: 11.5 }}>{data.title || 'Etapa'}</b>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function NoteNode({ data, selected }) {
  return (
    <div className={'wfnode wfnode-note' + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} />
      <div className="dim" style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', maxWidth: 180 }}>{data.text || 'Nota…'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AgentNode({ data, selected }) {
  const hasSchema = data.tieneSchema || (data.schemaText && data.schemaText.trim());
  return (
    <div className={'wfnode wfnode-agent' + (selected ? ' selected' : '') + (data.readOnly ? ' readonly' : '')}>
      <Handle type="target" position={Position.Left} />
      <div className="mono" style={{ fontSize: 11.5 }}>{data.label || 'agente'}</div>
      <div className="row wrap" style={{ gap: 3, marginTop: 4 }}>
        {data.effort && <span className="chip dim" style={{ fontSize: 9 }}>{data.effort}</span>}
        {hasSchema && <span className="chip on" style={{ fontSize: 9 }}>schema</span>}
        {data.concurrencia && <span className="chip" style={{ fontSize: 9 }}>{data.concurrencia}</span>}
        {data.linea && <span className="chip dim" style={{ fontSize: 9 }}>L{data.linea}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupNode({ data }) {
  return (
    <div className="wfnode-group-box">
      <Handle type="target" position={Position.Left} />
      <div className="wfnode-group-label">{data.label || 'Grupo paralelo'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ReturnNode({ data, selected }) {
  return (
    <div className={'wfnode wfnode-return' + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} />
      <b style={{ fontSize: 11.5 }}>return</b>
      <div className="mono dim" style={{ fontSize: 10 }}>{data.expression || '{}'}</div>
    </div>
  );
}

const NODE_TYPES = { phase: PhaseNode, note: NoteNode, agent: AgentNode, group: GroupNode, return: ReturnNode };

// --- panel de propiedades ----------------------------------------------------

function Ejemplo({ children }) {
  return <div className="dim" style={{ fontSize: 10, lineHeight: 1.5, margin: '3px 0 0' }}>{children}</div>;
}

function Inspector({ node, varsDisponibles, onChange, onDelete, onSalirDelGrupo }) {
  const d = node.data;
  return (
    <div className="card wf-inspector">
      <div className="row" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 12 }}>{labelOf(node)}</b>
        <button className="btn sm right" onClick={onDelete}>Borrar</button>
      </div>

      {node.type === 'agent' && (
        <>
          <label className="dim" style={{ fontSize: 10.5 }}>Label</label>
          <input
            value={d.label} onChange={(e) => onChange({ label: e.target.value })}
            placeholder="Ej: revisar-diff, buscar-precedentes"
            style={{ width: '100%' }}
          />
          <Ejemplo>Corto y descriptivo — es el nombre que vas a ver en los logs y en el Diagrama.</Ejemplo>

          <label className="dim" style={{ fontSize: 10.5, marginTop: 8, display: 'block' }}>
            Prompt {!d.promptIsExpr && '· podés usar {{prev}} y {{args}}'}
          </label>
          <textarea
            value={d.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder={d.promptIsExpr
              ? "Ej: 'Revisá ' + args.alcance + ' y reportá bugs.'"
              : 'Ej: Revisá el diff con git diff y reportá bugs de seguridad y de lógica.\nContexto: {{args}}'}
            style={{ width: '100%', minHeight: 90, fontFamily: d.promptIsExpr ? 'ui-monospace, monospace' : 'inherit', fontSize: 12 }}
          />
          <Ejemplo>
            {d.promptIsExpr
              ? 'Expresión JS cruda: se pega tal cual en el código, sin comillas alrededor.'
              : '{{prev}} inserta el resultado del paso anterior; {{args}} inserta lo que le pasás al workflow al invocarlo.'}
          </Ejemplo>
          <label className="row" style={{ fontSize: 11, margin: '8px 0', gap: 6 }}>
            <input type="checkbox" checked={!!d.promptIsExpr} onChange={(e) => onChange({ promptIsExpr: e.target.checked })} />
            Usar expresión JS cruda
          </label>

          <label className="dim" style={{ fontSize: 10.5 }}>Effort</label>
          <select value={d.effort || ''} onChange={(e) => onChange({ effort: e.target.value })} style={{ width: '100%' }}>
            <option value="">(default)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <Ejemplo><span className="mono">low</span> para lecturas simples, <span className="mono">high</span> para las que necesitan más criterio.</Ejemplo>

          <label className="dim" style={{ fontSize: 10.5, marginTop: 8, display: 'block' }}>Schema (objeto JS, opcional)</label>
          <textarea
            value={d.schemaText}
            onChange={(e) => onChange({ schemaText: e.target.value })}
            placeholder={"Ej: { type: 'object', properties: { hallazgos: { type: 'array' } }, required: ['hallazgos'] }"}
            style={{ width: '100%', minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          />
          <Ejemplo>Si lo dejás vacío, el agente devuelve texto libre en vez de un objeto con esta forma.</Ejemplo>

          {onSalirDelGrupo && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={onSalirDelGrupo}>Sacar del grupo</button>
          )}
        </>
      )}

      {node.type === 'note' && (
        <>
          <textarea
            value={d.text} onChange={(e) => onChange({ text: e.target.value })}
            placeholder="Ej: Esta etapa asume que el build ya corrió antes."
            style={{ width: '100%', minHeight: 90, fontSize: 12 }}
          />
          <Ejemplo>Se convierte en un comentario (<span className="mono">// texto</span>) — no ejecuta nada.</Ejemplo>
        </>
      )}

      {node.type === 'phase' && (
        <>
          <input
            value={d.title} onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Ej: Revisar, Verificar, Investigar"
            style={{ width: '100%' }}
          />
          <Ejemplo>Corto — aparece tal cual en <span className="mono">meta.phases</span> y en las columnas del Diagrama.</Ejemplo>
        </>
      )}

      {node.type === 'group' && (
        <>
          <input
            value={d.label} onChange={(e) => onChange({ label: e.target.value })}
            placeholder="Ej: Chequeos, Búsquedas"
            style={{ width: '100%' }}
          />
          <Ejemplo>Solo cosmético (para ubicarte en el canvas) — no aparece en el código generado.</Ejemplo>
        </>
      )}

      {node.type === 'return' && (
        <>
          <textarea
            value={d.expression}
            onChange={(e) => onChange({ expression: e.target.value })}
            placeholder="Ej: { hallazgos: r2 }"
            style={{ width: '100%', minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <Ejemplo>
            Expresión JS cruda para el <span className="mono">return</span> final. Combiná{' '}
            {varsDisponibles.length > 0 ? varsDisponibles.map((v) => v.v).join(', ') : 'r1, r2…'}{' '}
            (resultado de cada paso anterior, en orden).
          </Ejemplo>
          {varsDisponibles.length > 0 && (
            <div className="dim" style={{ fontSize: 10.5, marginTop: 6 }}>
              Variables disponibles: {varsDisponibles.map((v) => `${v.v} (${v.label})`).join(', ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- editor -------------------------------------------------------------

export default function WorkflowGraphEditor(props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ content, analisis, onGenerate, active }) {
  const [initialDoc] = useState(() => {
    const embedded = extractGraph(content);
    return (embedded && embedded.graph) || fromAnalysis(analisis);
  });
  const [nodes, setNodes] = useNodesState(initialDoc.nodes || []);
  const [edges, setEdges] = useEdgesState(initialDoc.edges || []);
  const [meta, setMeta] = useState(initialDoc.meta || { name: '', description: '', whenToUse: '' });
  const [readOnly, setReadOnly] = useState(!!initialDoc.readOnly);
  const usaPipeline = !!initialDoc.usaPipeline;
  const [selectedId, setSelectedId] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef(null);
  const flow = useReactFlow();

  // El canvas se guarda visible con display:none al cambiar de pestaña (para
  // no perder el layout a mitad de edición); React Flow necesita un fitView
  // nuevo cuando vuelve a quedar visible, porque el primero midió un
  // contenedor con tamaño 0.
  useEffect(() => {
    if (active) flow.fitView({ padding: 0.2, duration: 150 });
  }, [active, flow]);

  const graphDoc = useMemo(() => ({ version: 1, meta, nodes, edges }), [meta, nodes, edges]);
  const check = useMemo(() => validateGraph(graphDoc), [graphDoc]);
  const selected = nodes.find((n) => n.id === selectedId) || null;

  const varsDisponibles = useMemo(() => {
    const chain = previewChain(graphDoc).filter((n) => n.type === 'agent' || n.type === 'group');
    return chain.map((n, i) => ({ v: 'r' + (i + 1), label: labelOf(n) }));
  }, [graphDoc]);

  const handleNodesChange = useCallback((changes) => {
    setNodes((nds) => {
      const removeIds = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
      let next = applyNodeChanges(changes, nds);
      if (removeIds.size) next = next.filter((n) => !n.parentId || !removeIds.has(n.parentId));
      return next;
    });
  }, [setNodes]);

  const onConnect = useCallback((params) => {
    if (readOnly) return;
    setEdges((es) => addEdge({ ...params, id: params.source + '>' + params.target }, es));
  }, [readOnly, setEdges]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    if (readOnly) return;
    const type = e.dataTransfer.getData('application/wf-node-type');
    if (!type) return;
    const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setNodes((nds) => {
      const node = makeNode(type, pos);
      if (!node) return nds;
      const group = type === 'agent' ? nds.find((n) => n.type === 'group' && pointInNode(pos, n)) : null;
      if (group) {
        node.parentId = group.id;
        node.extent = 'parent';
        node.position = { x: pos.x - group.position.x, y: pos.y - group.position.y };
      }
      return nds.concat(node);
    });
  }, [flow, readOnly, setNodes]);

  const onNodeDragStop = useCallback((_e, dragged) => {
    if (readOnly || dragged.type !== 'agent' || dragged.parentId) return;
    setNodes((nds) => {
      const group = nds.find((n) => n.type === 'group' && n.id !== dragged.id && pointInNode(dragged.position, n));
      if (!group) return nds;
      return nds.map((n) => (n.id === dragged.id
        ? { ...n, parentId: group.id, extent: 'parent', position: { x: dragged.position.x - group.position.x, y: dragged.position.y - group.position.y } }
        : n));
    });
  }, [readOnly, setNodes]);

  const salirDelGrupo = useCallback((id) => {
    setNodes((nds) => {
      const node = nds.find((n) => n.id === id);
      if (!node || !node.parentId) return nds;
      const parent = nds.find((n) => n.id === node.parentId);
      const abs = parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position;
      return nds.map((n) => {
        if (n.id !== id) return n;
        const updated = { ...n, position: abs };
        delete updated.parentId;
        delete updated.extent;
        return updated;
      });
    });
  }, [setNodes]);

  const empezarDeCero = () => {
    setNodes([]);
    setEdges([]);
    setMeta({ name: '', description: '', whenToUse: '' });
    setReadOnly(false);
  };

  const aplicar = () => {
    if (!check.ok) return;
    setBusy(true);
    try { onGenerate(generateSource(graphDoc)); }
    catch (e) { window.alert(e.message); }
    finally { setBusy(false); }
  };

  const borrarSeleccionado = () => {
    setNodes((nds) => nds.filter((n) => n.id !== selected.id && n.parentId !== selected.id));
    setEdges((eds) => eds.filter((e) => e.source !== selected.id && e.target !== selected.id));
    setSelectedId(null);
  };

  const paletteFiltrada = PALETTE.filter((p) => !filtro
    || p.label.toLowerCase().includes(filtro.toLowerCase())
    || p.hint.toLowerCase().includes(filtro.toLowerCase()));

  return (
    <div className="wf-editor">
      {readOnly && (
        <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11.5, marginBottom: 8 }}>
          Esto es una reconstrucción aproximada de leer el código, no de ejecutarlo — no se puede editar acá.
          {usaPipeline && ' Además usa pipeline(), que el editor visual todavía no genera: para tocar la estructura, usá la pestaña Código.'}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={empezarDeCero}>Empezar un diagrama nuevo</button>
        </div>
      )}

      <div className="wf-body">
        {!readOnly && (
          <div className="wf-palette">
            <input
              type="search" placeholder="Buscar componentes…" value={filtro}
              onChange={(e) => setFiltro(e.target.value)} style={{ width: '100%', marginBottom: 8 }}
            />
            {paletteFiltrada.map((p) => (
              <div
                key={p.type} className="card wf-palette-item" draggable
                onDragStart={(e) => e.dataTransfer.setData('application/wf-node-type', p.type)}
                title={p.hint}
              >
                <b style={{ fontSize: 12 }}>{p.label}</b>
                <div className="dim" style={{ fontSize: 10.5, marginTop: 2 }}>{p.hint}</div>
              </div>
            ))}
            {!paletteFiltrada.length && <div className="dim" style={{ fontSize: 11 }}>Sin resultados.</div>}
          </div>
        )}

        <div className="wf-canvas-wrap" ref={wrapperRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {!readOnly && !nodes.length && (
            <div className="wf-canvas-hint dim">Arrastrá un componente de la izquierda para empezar.</div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={handleNodesChange}
            onEdgesChange={(changes) => setEdges((eds) => applyEdgeChanges(changes, eds))}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={({ nodes: sel }) => setSelectedId((sel && sel[0] && sel[0].id) || null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {selected && !readOnly && (
          <Inspector
            node={selected}
            varsDisponibles={varsDisponibles}
            onChange={(data) => setNodes((nds) => nds.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, ...data } } : n)))}
            onDelete={borrarSeleccionado}
            onSalirDelGrupo={selected.parentId ? () => salirDelGrupo(selected.id) : null}
          />
        )}
      </div>

      {!readOnly && (
        <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
          <input placeholder="Nombre del workflow" value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} style={{ minWidth: 180 }} />
          <input placeholder="Descripción" value={meta.description} onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} style={{ minWidth: 260, flex: 1 }} />
          <button className="btn sm primary" disabled={!check.ok || busy} onClick={aplicar}>Aplicar cambios</button>
          {!check.ok && (
            <span className="chip bad" style={{ fontSize: 10.5 }} title={check.errors.join('\n')}>{check.errors.length} problema(s)</span>
          )}
          {check.ok && check.warnings.length > 0 && (
            <span className="chip warn" style={{ fontSize: 10.5 }} title={check.warnings.join('\n')}>{check.warnings.length} aviso(s)</span>
          )}
        </div>
      )}
    </div>
  );
}
