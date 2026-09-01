import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force';

// Dibujo del grafo con simulacion de fuerzas. La simulacion corre en un bucle
// de animacion y se frena sola cuando el layout se enfria (alpha bajo): dejarla
// girando para siempre gasta CPU sin mover casi nada.

const NODE_COLOR = {
  Function: '#d97757', Method: '#e08a6a',
  Class: '#6c9fd8', Interface: '#8fb8e3', Component: '#6c9fd8',
  File: '#7cae7a', Module: '#96c093', Folder: '#5f9b5d', Project: '#4d8a4b',
  Variable: '#918c81', Field: '#a8a299', Constant: '#a8a299', Section: '#7a756c',
  Route: '#a98bd4', Endpoint: '#a98bd4', Decorator: '#c0a5e0',
  Table: '#d9b45b', Type: '#d9b45b', EnvVar: '#c4a24e',
};
const colorOf = (label) => NODE_COLOR[label] || '#6b675f';

const REL_COLOR = {
  CALLS: '#d97757', IMPORTS: '#6c9fd8', USAGE: '#7cae7a',
  EXTENDS: '#a98bd4', IMPLEMENTS: '#a98bd4', REFERENCES: '#918c81',
};

const W = 900;
const H = 520;

export default function GraphCanvas({ data, selectedId, onSelect, onExpand }) {
  const [, forceRender] = useState(0);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState(null);

  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const simRef = useRef(null);
  const rafRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);

  // Rearma la simulacion cada vez que cambia el subgrafo.
  useEffect(() => {
    if (simRef.current) simRef.current.stop();
    cancelAnimationFrame(rafRef.current);

    const nodes = (data.nodes || []).map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = (data.edges || [])
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ ...e }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(60).strength(0.35))
      .force('charge', forceManyBody().strength(-180).distanceMax(420))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide().radius((d) => radius(d) + 4))
      .force('x', forceX(W / 2).strength(0.03))
      .force('y', forceY(H / 2).strength(0.03))
      .alpha(1)
      .stop();

    simRef.current = sim;

    const loop = () => {
      sim.tick();
      forceRender((v) => v + 1);
      if (sim.alpha() > 0.03) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(rafRef.current); sim.stop(); };
  }, [data]);

  const reheat = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.alpha(0.35);
    cancelAnimationFrame(rafRef.current);
    const loop = () => {
      sim.tick();
      forceRender((v) => v + 1);
      if (sim.alpha() > 0.03) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // --- interaccion ---------------------------------------------------------

  const toWorld = (e, svg) => {
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width * W - view.x) / view.k,
      y: ((e.clientY - r.top) / r.height * H - view.y) / view.k,
    };
  };

  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const k = Math.min(4, Math.max(0.25, v.k * factor));
      return { ...v, k };
    });
  };

  const onMouseDown = (e) => {
    if (e.target.dataset && e.target.dataset.nodeId) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };

  const onMouseMove = (e) => {
    if (dragRef.current) {
      const svg = e.currentTarget;
      const p = toWorld(e, svg);
      const n = dragRef.current;
      n.fx = p.x; n.fy = p.y;
      reheat();
      return;
    }
    if (panRef.current) {
      const p = panRef.current;
      setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
    }
  };

  const endDrag = () => {
    if (dragRef.current) { dragRef.current.fx = null; dragRef.current.fy = null; dragRef.current = null; }
    panRef.current = null;
  };

  const nodes = nodesRef.current;
  const links = linksRef.current;

  const neighborIds = useMemo(() => {
    if (!selectedId) return null;
    const s = new Set([selectedId]);
    for (const l of links) {
      const a = l.source.id || l.source;
      const b = l.target.id || l.target;
      if (a === selectedId) s.add(b);
      if (b === selectedId) s.add(a);
    }
    return s;
  }, [selectedId, links]);

  const legend = useMemo(() => {
    const counts = {};
    for (const n of nodes) counts[n.label] = (counts[n.label] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [nodes]);

  const rels = useMemo(() => {
    const counts = {};
    for (const l of links) counts[l.rel] = (counts[l.rel] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [links]);

  if (!nodes.length) {
    return (
      <div className="empty">
        Este subgrafo no tiene conexiones de los tipos elegidos.
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          Probá activando más tipos de relación arriba.
        </div>
      </div>
    );
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: '100%', height: 520, display: 'block',
          background: 'var(--panel-2)', border: '1px solid var(--line)',
          borderRadius: 8, cursor: panRef.current ? 'grabbing' : 'grab',
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="18" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a3a36" />
          </marker>
        </defs>

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map((l, i) => {
            const a = l.source; const b = l.target;
            if (!a.x || !b.x) return null;
            const dim = neighborIds && !(neighborIds.has(a.id) && neighborIds.has(b.id));
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={REL_COLOR[l.rel] || '#3a3a36'}
                strokeOpacity={dim ? 0.07 : 0.45}
                strokeWidth={1.2}
                markerEnd="url(#arrow)"
              />
            );
          })}

          {nodes.map((n) => {
            const r = radius(n);
            const dim = neighborIds && !neighborIds.has(n.id);
            const isSel = n.id === selectedId;
            return (
              <g key={n.id} transform={`translate(${n.x || 0},${n.y || 0})`}>
                <circle
                  data-node-id={n.id}
                  r={r}
                  fill={colorOf(n.label)}
                  fillOpacity={dim ? 0.15 : 0.9}
                  stroke={isSel ? '#f2f0ea' : 'rgba(0,0,0,0.35)'}
                  strokeWidth={isSel ? 2.5 : 1}
                  style={{ cursor: 'pointer' }}
                  onMouseDown={(e) => { e.stopPropagation(); dragRef.current = n; }}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => { e.stopPropagation(); onSelect && onSelect(n); }}
                  onDoubleClick={(e) => { e.stopPropagation(); onExpand && onExpand(n); }}
                />
                {(r > 7 || isSel || (hover && hover.id === n.id)) && (
                  <text
                    x={r + 4} y={4}
                    fill={dim ? '#4a4741' : '#c9c4ba'}
                    fontSize={10}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {n.name.length > 26 ? n.name.slice(0, 25) + '…' : n.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        <span className="dim" style={{ fontSize: 11 }}>Nodos:</span>
        {legend.map(([label, count]) => (
          <span key={label} className="chip" style={{ fontSize: 10, borderColor: colorOf(label) }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: colorOf(label), display: 'inline-block',
            }} />
            {label} <span className="dim">{count}</span>
          </span>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        <span className="dim" style={{ fontSize: 11 }}>Relaciones:</span>
        {rels.map(([rel, count]) => (
          <span key={rel} className="chip" style={{ fontSize: 10, borderColor: REL_COLOR[rel] || 'var(--line)' }}>
            <span style={{ width: 12, height: 2, background: REL_COLOR[rel] || '#3a3a36', display: 'inline-block' }} />
            {rel} <span className="dim">{count}</span>
          </span>
        ))}
      </div>

      <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
        Rueda para zoom · arrastrá el fondo para mover · arrastrá un nodo para acomodarlo ·
        clic para ver el código · doble clic para abrir su vecindario
        {hover && <span> · <b style={{ color: 'var(--text)' }}>{hover.name}</b> ({hover.label}, {hover.degree} conexiones)</span>}
      </div>
    </div>
  );
}

// Los nodos muy conectados se dibujan mas grandes: de un vistazo se ve donde
// esta el nucleo del sistema.
function radius(n) {
  const d = n.degree || 1;
  return Math.min(20, 4 + Math.sqrt(d) * 2.4);
}
