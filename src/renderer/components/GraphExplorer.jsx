import React, { useCallback, useEffect, useState } from 'react';
import { fmtInt } from '../util.js';
import GraphCanvas from './GraphCanvas.jsx';

// Traduccion de las etiquetas del grafo, que el servidor devuelve en ingles.
const LABEL_ES = {
  Function: 'Función', Method: 'Método', Class: 'Clase', Interface: 'Interfaz',
  Variable: 'Variable', Field: 'Campo', File: 'Archivo', Module: 'Módulo',
  Folder: 'Carpeta', Package: 'Paquete', Route: 'Ruta', Endpoint: 'Endpoint',
  Table: 'Tabla', Component: 'Componente', Type: 'Tipo', Enum: 'Enum',
  Property: 'Propiedad', Constant: 'Constante', Test: 'Test',
};
const esLabel = (l) => LABEL_ES[l] || l || '—';

// Mismos valores por defecto que usa el proceso principal.
const DEFAULT_RELS = ['CALLS', 'IMPORTS', 'USAGE', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES'];

const REL_HELP = {
  CALLS: 'A llama a B',
  IMPORTS: 'A importa B',
  USAGE: 'A usa B sin llamarlo directamente',
  DEFINES: 'A define a B (jerarquia archivo -> simbolo): son muchisimas y tapan el dibujo',
  CONTAINS_FILE: 'La carpeta contiene el archivo',
  CONTAINS_FOLDER: 'La carpeta contiene otra carpeta',
  EXTENDS: 'A hereda de B',
  IMPLEMENTS: 'A implementa la interfaz B',
  SEMANTICALLY_RELATED: 'Parecidos por contenido, no por codigo',
  REFERENCES: 'A menciona a B',
};

const LABEL_COLOR = {
  Function: 'var(--accent)', Method: 'var(--accent)',
  Class: 'var(--blue)', Interface: 'var(--blue)', Component: 'var(--blue)',
  Variable: 'var(--muted)', Field: 'var(--muted)', Constant: 'var(--muted)',
  File: 'var(--green)', Module: 'var(--green)', Folder: 'var(--green)',
  Route: 'var(--purple)', Endpoint: 'var(--purple)', Table: 'var(--yellow)',
};

function shortPath(p, keep = 46) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  return s.length > keep ? '…' + s.slice(-keep) : s;
}

export default function GraphExplorer({ store, onClose, flash }) {
  const [projects, setProjects] = useState(null);
  const [project, setProject] = useState('');
  const [arch, setArch] = useState(null);
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [traceResult, setTraceResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('mapa');
  const [sub, setSub] = useState(null);
  const [subBusy, setSubBusy] = useState(false);
  const [rels, setRels] = useState(null);      // null = los que trae por defecto
  const [relOptions, setRelOptions] = useState([]);
  const [focus, setFocus] = useState(null);    // nodo cuyo vecindario se mira

  // Elige el proyecto del grafo que corresponde al repo desde el que abriste.
  useEffect(() => {
    let alive = true;
    window.cockpit.graphProjects()
      .then((ps) => {
        if (!alive) return;
        setProjects(ps);
        const want = String(store.root || '').replace(/\\/g, '/').toLowerCase();
        const hit = ps.find((p) => String(p.rootPath || '').toLowerCase() === want)
          || ps.slice().sort((a, b) => b.nodes - a.nodes)[0];
        if (hit) setProject(hit.name);
      })
      .catch((e) => flash('No se pudo listar el grafo: ' + e.message, true));
    return () => { alive = false; };
  }, [store, flash]);

  useEffect(() => {
    if (!project) return;
    setArch(null); setResults(null); setSelected(null); setSnippet(null); setTraceResult(null);
    setSub(null); setFocus(null); setRels(null);
    window.cockpit.graphArchitecture(project)
      .then(setArch)
      .catch((e) => flash('No se pudo leer la arquitectura: ' + e.message, true));
    window.cockpit.graphSchema(project)
      .then((sc) => setRelOptions(((sc && sc.edge_types) || []).map((e) => e.type)))
      .catch(() => setRelOptions([]));
  }, [project, flash]);

  // Trae el subgrafo a dibujar: la vista general, o el vecindario de un nodo.
  useEffect(() => {
    if (!project || tab !== 'mapa') return;
    let alive = true;
    setSubBusy(true);
    const opts = { limit: focus ? 150 : 400 };
    if (focus) opts.around = focus.id;
    if (rels && rels.length) opts.relationships = rels;
    window.cockpit.graphSubgraph(project, opts)
      .then((g) => { if (alive) setSub(g); })
      .catch((e) => { if (alive) flash('No se pudo dibujar el grafo: ' + e.message, true); })
      .finally(() => { if (alive) setSubBusy(false); });
    return () => { alive = false; };
  }, [project, tab, focus, rels, flash]);

  const runSearch = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!project) return;
    setBusy(true); setSelected(null); setSnippet(null); setTraceResult(null);
    try {
      const opts = { limit: 80 };
      if (query.trim()) opts.namePattern = query.trim();
      else opts.namePattern = '.*';
      if (label) opts.label = label;
      setResults(await window.cockpit.graphSearch(project, opts));
    } catch (err) {
      flash('Error en la búsqueda: ' + err.message, true);
    } finally {
      setBusy(false);
    }
  }, [project, query, label, flash]);

  const open = async (node) => {
    setSelected(node); setSnippet(null); setTraceResult(null);
    if (!node.qualifiedName) return;
    try {
      setSnippet(await window.cockpit.graphSnippet(project, node.qualifiedName, true));
    } catch (e) {
      flash('No se pudo traer el código: ' + e.message, true);
    }
  };

  const doTrace = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setTraceResult(await window.cockpit.graphTrace(project, selected.name, { mode: 'calls', depth: 3 }));
    } catch (e) {
      flash('No se pudo trazar: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const labels = (arch && arch.node_labels) || [];

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={onClose}>← Volver a memorias</button>
        <b style={{ fontSize: 13 }}>Explorador del grafo</b>
        {projects && (
          <select value={project} onChange={(e) => setProject(e.target.value)} style={{ flex: 1, maxWidth: 460, fontSize: 11.5 }}>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.rootPath ? p.rootPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : p.name}
                {' — '}{fmtInt(p.nodes)} nodos
              </option>
            ))}
          </select>
        )}
        {!projects && <span className="spin" />}
      </div>

      <div className="row" style={{ gap: 6 }}>
        {[['mapa', 'Mapa'], ['buscador', 'Buscador']].map(([id, label]) => (
          <button
            key={id}
            className={'btn sm' + (tab === id ? ' primary' : '')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        {tab === 'mapa' && focus && (
          <>
            <span className="chip alt">vecindario de <b>{focus.name}</b></span>
            <button className="btn sm" onClick={() => setFocus(null)}>Ver todo el mapa</button>
          </>
        )}
        {subBusy && <span className="spin" />}
      </div>

      {tab === 'mapa' && (
        <div className="card">
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            <span className="dim" style={{ fontSize: 11 }}>Mostrar relaciones:</span>
            {relOptions.map((r) => {
              const on = rels ? rels.includes(r) : DEFAULT_RELS.includes(r);
              return (
                <span
                  key={r}
                  className={'chip' + (on ? ' on' : '')}
                  style={{ cursor: 'pointer', fontSize: 10 }}
                  title={REL_HELP[r] || 'Relación del grafo'}
                  onClick={() => {
                    const base = rels || DEFAULT_RELS.filter((x) => relOptions.includes(x));
                    setRels(on ? base.filter((x) => x !== r) : base.concat([r]));
                  }}
                >
                  {r}
                </span>
              );
            })}
            {rels && <button className="btn sm" onClick={() => setRels(null)}>Restablecer</button>}
          </div>

          {!sub ? (
            <div className="empty"><span className="spin" /> armando el mapa…</div>
          ) : (
            <>
              <GraphCanvas
                data={sub}
                selectedId={selected && selected.qualifiedName}
                onSelect={(n) => open({ name: n.name, qualifiedName: n.id, label: n.label })}
                onExpand={(n) => setFocus({ id: n.id, name: n.name })}
              />
              {sub.truncated && (
                <div className="chip warn" style={{ marginTop: 8 }}>
                  El grafo es más grande que lo dibujado: se muestran las primeras conexiones.
                  Doble clic en un nodo para ver su vecindario completo.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {arch && tab === 'buscador' && (
        <div className="card">
          <h3>Arquitectura</h3>
          <div className="grid g4" style={{ gap: 10, marginBottom: 12 }}>
            <div title="Cantidad de símbolos indexados: funciones, clases, archivos, variables…">
              <div className="dim" style={{ fontSize: 10.5 }}>NODOS</div>
              <b style={{ fontSize: 18 }}>{fmtInt(arch.total_nodes)}</b>
            </div>
            <div title="Relaciones entre símbolos: llamadas, herencia, importaciones, contención…">
              <div className="dim" style={{ fontSize: 10.5 }}>RELACIONES</div>
              <b style={{ fontSize: 18 }}>{fmtInt(arch.total_edges)}</b>
            </div>
            <div title="Lenguajes detectados en el repositorio indexado">
              <div className="dim" style={{ fontSize: 10.5 }}>LENGUAJES</div>
              <b style={{ fontSize: 13 }}>
                {(arch.languages || []).slice(0, 3).map((l) => (typeof l === 'string' ? l : l.language || l.name)).join(', ') || '—'}
              </b>
            </div>
            <div title="Símbolos con más conexiones: suelen ser el corazón del sistema, y lo más riesgoso de tocar">
              <div className="dim" style={{ fontSize: 10.5 }}>PUNTOS CALIENTES</div>
              <b style={{ fontSize: 18 }}>{fmtInt((arch.hotspots || []).length)}</b>
            </div>
          </div>

          <div className="row wrap" style={{ gap: 5 }}>
            {labels.slice(0, 14).map((l) => (
              <span
                key={l.label}
                className="chip"
                style={{ cursor: 'pointer', borderColor: LABEL_COLOR[l.label] || 'var(--line)' }}
                title={`Filtrar por ${esLabel(l.label)}`}
                onClick={() => { setLabel(l.label === label ? '' : l.label); setQuery(''); }}
              >
                {esLabel(l.label)} <span className="dim">{fmtInt(l.count)}</span>
              </span>
            ))}
          </div>

          {(arch.hotspots || []).length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="chip warn">Puntos calientes del código</summary>
              <div className="card" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
                <table>
                  <thead><tr><th>Símbolo</th><th>Archivo</th><th className="n">Conexiones</th></tr></thead>
                  <tbody>
                    {(arch.hotspots || []).slice(0, 25).map((h, i) => (
                      <tr key={i} className="clickable" onClick={() => open({ name: h.name, qualifiedName: h.qualified_name || h.name })}>
                        <td className="mono" style={{ fontSize: 11.5 }}>{h.name}</td>
                        <td className="dim mono" style={{ fontSize: 10.5 }}>{shortPath(h.file || h.file_path)}</td>
                        <td className="n">{h.degree != null ? h.degree : (h.connections || '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {tab === 'buscador' && (
      <div className="card">
        <form onSubmit={runSearch} className="row" style={{ gap: 6, marginBottom: 10 }}>
          <input
            type="search"
            placeholder="Nombre del símbolo (acepta expresiones regulares: ^get, Service$, .*Repo.*)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={label} onChange={(e) => setLabel(e.target.value)} style={{ fontSize: 11.5 }}>
            <option value="">Cualquier tipo</option>
            {labels.map((l) => <option key={l.label} value={l.label}>{esLabel(l.label)}</option>)}
          </select>
          <button className="btn sm primary" type="submit" disabled={busy || !project}>
            {busy ? '…' : 'Buscar'}
          </button>
        </form>

        {!results ? (
          <div className="dim" style={{ fontSize: 12 }}>
            Buscá por nombre o tocá un tipo de arriba para listar todo lo de esa categoría.
          </div>
        ) : !results.length ? (
          <div className="dim">Sin coincidencias.</div>
        ) : (
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Tipo</th><th>Nombre</th><th>Archivo</th><th className="n">Conex.</th></tr></thead>
              <tbody>
                {results.map((n, i) => (
                  <tr
                    key={i}
                    className="clickable"
                    onClick={() => open(n)}
                    style={selected && selected.qualifiedName === n.qualifiedName ? { background: 'var(--accent-soft)' } : null}
                  >
                    <td>
                      <span className="chip" style={{ fontSize: 10, borderColor: LABEL_COLOR[n.label] || 'var(--line)' }}>
                        {esLabel(n.label)}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 300 }}>
                      <div className="trunc" title={n.qualifiedName || n.name}>{n.name}</div>
                    </td>
                    <td className="dim mono" style={{ fontSize: 10.5 }}>{shortPath(n.file)}</td>
                    <td className="n dim">{n.degree != null ? n.degree : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {selected && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <b className="mono" style={{ fontSize: 12.5 }}>{selected.name}</b>
            {snippet && snippet.label && <span className="chip">{esLabel(snippet.label)}</span>}
            {snippet && snippet.complexity != null && (
              <span className="chip" title="Complejidad ciclomática: cuántos caminos distintos puede tomar la ejecución. Más alto, más difícil de testear.">
                complejidad {snippet.complexity}
              </span>
            )}
            {snippet && snippet.is_entry_point && (
              <span className="chip alt" title="Es un punto de entrada: nada del código indexado lo llama, lo dispara algo externo">
                punto de entrada
              </span>
            )}
            {snippet && snippet.is_test && <span className="chip on">test</span>}
            <div className="right row" style={{ gap: 6 }}>
              <button
                className="btn sm"
                title="Dibuja solo lo que se conecta con este simbolo"
                onClick={() => { setFocus({ id: selected.qualifiedName, name: selected.name }); setTab('mapa'); }}
              >
                Ver en el mapa
              </button>
              <button className="btn sm" onClick={doTrace} disabled={busy}>Trazar llamadas</button>
              {snippet && snippet.file_path && (
                <button className="btn sm" onClick={() => window.cockpit.revealPath(snippet.file_path)}>
                  Ver archivo
                </button>
              )}
            </div>
          </div>

          {snippet && snippet.file_path && (
            <div className="dim mono" style={{ fontSize: 10.5, marginBottom: 8 }}>
              {snippet.file_path}
              {snippet.start_line ? `:${snippet.start_line}` : ''}
              {snippet.end_line ? `-${snippet.end_line}` : ''}
            </div>
          )}

          {snippet && snippet.source && (
            <div className="block" style={{ maxHeight: 320, overflow: 'auto' }}>
              <pre>{snippet.source}</pre>
            </div>
          )}

          {snippet && ((snippet.callers || []).length > 0 || (snippet.callees || []).length > 0) && (
            <div className="grid g2" style={{ marginTop: 10 }}>
              <div>
                <div className="dim" style={{ fontSize: 10.5, marginBottom: 5 }} title="Quién llama a este símbolo">
                  LO LLAMAN ({(snippet.callers || []).length})
                </div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {(snippet.callers || []).slice(0, 20).map((c, i) => (
                    <span key={i} className="chip mono" style={{ fontSize: 10, cursor: 'pointer' }}
                      onClick={() => open({ name: c.name || c, qualifiedName: c.qualified_name || c.name || c })}>
                      {c.name || c}
                    </span>
                  ))}
                  {!(snippet.callers || []).length && <span className="dim">nadie</span>}
                </div>
              </div>
              <div>
                <div className="dim" style={{ fontSize: 10.5, marginBottom: 5 }} title="A quién llama este símbolo">
                  LLAMA A ({(snippet.callees || []).length})
                </div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {(snippet.callees || []).slice(0, 20).map((c, i) => (
                    <span key={i} className="chip mono" style={{ fontSize: 10, cursor: 'pointer' }}
                      onClick={() => open({ name: c.name || c, qualifiedName: c.qualified_name || c.name || c })}>
                      {c.name || c}
                    </span>
                  ))}
                  {!(snippet.callees || []).length && <span className="dim">nada</span>}
                </div>
              </div>
            </div>
          )}

          {traceResult && (
            <details open style={{ marginTop: 12 }}>
              <summary className="chip info">Cadena de llamadas</summary>
              <div className="block" style={{ marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
                <pre>{JSON.stringify(traceResult, null, 1)}</pre>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
