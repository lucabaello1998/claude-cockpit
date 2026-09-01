import React, { useEffect, useMemo, useState } from 'react';
import GraphExplorer from './GraphExplorer.jsx';
import { fmtInt, fmtBytes, fmtAgo, basename } from '../util.js';

const TYPE_CHIP = {
  user: 'info', feedback: 'warn', project: 'on', reference: 'alt',
};

function GraphStore({ s, onExplore }) {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 13.5 }}>{s.name}</b>
        <span className={'chip ' + (s.stale ? 'warn' : 'on')}>
          {s.stale ? 'desactualizado' : 'al día'}
        </span>
        <div className="right row" style={{ gap: 6 }}>
          {s.provider === 'codebase-memory' && (
            <button
              className="btn sm primary"
              title="Buscar simbolos, ver su codigo y quien los llama, sin salir de la app"
              onClick={() => onExplore(s)}
            >
              Explorar grafo
            </button>
          )}
          {s.htmlPath && (
            <button
              className="btn sm primary"
              title="Abre la visualizacion interactiva que genera Graphify en tu navegador"
              onClick={() => window.cockpit.openPath(s.htmlPath)}
            >
              Ver grafo
            </button>
          )}
          {s.reportPath && (
            <button className="btn sm" onClick={() => window.cockpit.openPath(s.reportPath)}>Reporte</button>
          )}
          <button className="btn sm" onClick={() => window.cockpit.openPath(s.dir)}>Carpeta</button>
        </div>
      </div>

      <div className="grid g4" style={{ gap: 10, marginBottom: 10 }}>
        <div title="Simbolos indexados: funciones, clases, archivos, variables...">
          <div className="dim" style={{ fontSize: 10.5 }}>NODOS</div>
          <b style={{ fontSize: 18 }}>{s.nodes == null ? '—' : fmtInt(s.nodes)}</b>
        </div>
        <div title="Relaciones entre simbolos: llamadas, herencia, importaciones, contencion...">
          <div className="dim" style={{ fontSize: 10.5 }}>RELACIONES</div>
          <b style={{ fontSize: 18 }}>{s.edges == null ? '—' : fmtInt(s.edges)}</b>
        </div>
        <div title="Tamano del grafo comprimido en el repositorio">
          <div className="dim" style={{ fontSize: 10.5 }}>EN DISCO</div>
          <b style={{ fontSize: 18 }}>{fmtBytes(s.compressedBytes)}</b>
        </div>
        <div title="Cuando se corrio el indexado por ultima vez">
          <div className="dim" style={{ fontSize: 10.5 }}>INDEXADO</div>
          <b style={{ fontSize: 13 }}>{fmtAgo(s.indexedAt)}</b>
        </div>
      </div>

      <div className="dim mono" style={{ fontSize: 11, lineHeight: 1.8 }}>
        <div className="trunc" title={s.root}>{s.root}</div>
        {s.indexedCommit && (
          <div>
            indexado en <b>{s.indexedCommit.slice(0, 8)}</b>
            {s.currentCommit && (
              <> · HEAD actual <b style={{ color: s.stale ? 'var(--yellow)' : 'inherit' }}>{s.currentCommit.slice(0, 8)}</b></>
            )}
          </div>
        )}
        {s.originalBytes > 0 && (
          <div>{fmtBytes(s.originalBytes)} sin comprimir ({Math.round(s.originalBytes / Math.max(1, s.compressedBytes))}× de compresión)</div>
        )}
        {s.exact === false && <div>tamaño del grafo estimado: archivo demasiado grande para contar exacto</div>}
      </div>

      {s.stale && (
        <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
          El repo avanzó desde el último indexado. Volvé a indexarlo para que las consultas al grafo
          reflejen el código actual.
        </div>
      )}
    </div>
  );
}

// Una tarjeta por proyecto, con las dos fuentes lado a lado.
function CodebaseCard({ e, onExplore }) {
  const live = e.live;
  const a = e.artifact;
  const nombre = e.root
    ? String(e.root).replace(/[\\/]+/g, '/').split('/').filter(Boolean).slice(-2).join('/')
    : e.name;
  const difieren = live && a && a.nodes && Math.abs(live.nodes - a.nodes) > Math.max(50, a.nodes * 0.1);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 13.5 }} title={e.root || e.name}>{nombre}</b>
        {a && (
          <span className={'chip ' + (a.stale ? 'warn' : 'on')}
            title={a.stale ? 'El repo avanzo desde que se exporto el artifact' : 'El artifact coincide con el HEAD actual'}>
            {a.stale ? 'exportacion vieja' : 'exportacion al dia'}
          </span>
        )}
        <div className="right row" style={{ gap: 6 }}>
          {live && (
            <button
              className="btn sm primary"
              title="Buscar simbolos, ver el mapa del grafo y quien llama a que"
              onClick={() => onExplore({ root: e.root, name: live.name, provider: 'codebase-memory' })}
            >
              Explorar grafo
            </button>
          )}
          {a && <button className="btn sm" onClick={() => window.cockpit.openPath(a.dir)}>Carpeta</button>}
        </div>
      </div>

      <div className="grid g2" style={{ gap: 12 }}>
        <div title="La base que el servidor MCP consulta de verdad cuando busca en el grafo">
          <div className="dim" style={{ fontSize: 10, letterSpacing: 0.5, marginBottom: 4 }}>ÍNDICE DEL SERVIDOR</div>
          {live ? (
            <div style={{ fontSize: 12 }}>
              <b style={{ fontSize: 17 }}>{fmtInt(live.nodes)}</b> nodos
              <span className="dim"> · {fmtInt(live.edges)} relaciones</span>
              <div className="dim" style={{ fontSize: 11 }}>{fmtBytes(live.sizeBytes)} en la base</div>
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 11.5 }}>
              No está en el índice del servidor: hay un artifact en el repo pero nunca se indexó acá.
            </div>
          )}
        </div>

        <div title="Foto portable del grafo, versionada dentro del repositorio">
          <div className="dim" style={{ fontSize: 10, letterSpacing: 0.5, marginBottom: 4 }}>EXPORTADO EN EL REPO</div>
          {a ? (
            <div style={{ fontSize: 12 }}>
              <b style={{ fontSize: 17 }}>{fmtInt(a.nodes)}</b> nodos
              <span className="dim"> · {fmtInt(a.edges)} relaciones</span>
              <div className="dim" style={{ fontSize: 11 }}>
                {fmtBytes(a.compressedBytes)} · {fmtAgo(a.indexedAt)}
              </div>
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 11.5 }}>
              Sin <code>.codebase-memory/</code> en el repo. El grafo funciona igual; esto solo sirve
              para versionarlo o llevarlo a otra máquina.
            </div>
          )}
        </div>
      </div>

      {a && a.indexedCommit && (
        <div className="dim mono" style={{ fontSize: 10.5, marginTop: 10 }}>
          exportado en <b>{a.indexedCommit.slice(0, 8)}</b>
          {a.currentCommit && (
            <> · HEAD actual <b style={{ color: a.stale ? 'var(--yellow)' : 'inherit' }}>{a.currentCommit.slice(0, 8)}</b></>
          )}
        </div>
      )}

      {difieren && (
        <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
          Los dos números no coinciden porque se generaron en momentos distintos. El que usa Claude
          para responderte es el del servidor.
        </div>
      )}
    </div>
  );
}

export default function MemoryPanel({ memory, flash }) {
  const [openStore, setOpenStore] = useState(null);
  const [exploring, setExploring] = useState(null);
  const [indexed, setIndexed] = useState(null);

  // El panel de arriba lista los repos que tienen .codebase-memory en disco.
  // El servidor MCP ademas guarda SU propio indice, que puede tener proyectos
  // sin artifact exportado: sin esto no aparecian en ningun lado.
  useEffect(() => {
    let alive = true;
    window.cockpit.graphProjects()
      .then((ps) => { if (alive) setIndexed(ps); })
      .catch(() => { if (alive) setIndexed([]); });
    return () => { alive = false; };
  }, []);

  const graphify = memory && memory.providers.find((p) => p.id === 'graphify');
  const cbmStores = (memory && (memory.providers.find((p) => p.id === 'codebase-memory') || {}).stores) || [];

  // Hay dos fuentes para lo mismo y decian numeros distintos:
  //   - el indice VIVO del servidor MCP (lo que se consulta de verdad)
  //   - el artifact.json EXPORTADO dentro de cada repo (una foto portable)
  // Se cruzan por ruta para mostrar un solo proyecto con las dos columnas.
  //
  // OJO: este useMemo va ANTES de los return tempranos. Si queda debajo, al
  // entrar y salir del explorador React ve distinta cantidad de hooks y rompe.
  const codebase = useMemo(() => {
    const norm = (x) => String(x || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    const byRoot = new Map();

    for (const live of indexed || []) {
      const key = norm(live.rootPath) || live.name;
      byRoot.set(key, { key, root: live.rootPath, name: live.name, live, artifact: null });
    }
    for (const a of cbmStores) {
      const key = norm(a.root);
      const hit = byRoot.get(key);
      if (hit) hit.artifact = a;
      else byRoot.set(key, { key, root: a.root, name: a.name, live: null, artifact: a });
    }
    const num = (e) => (e.live && e.live.nodes) || (e.artifact && e.artifact.nodes) || 0;
    return [...byRoot.values()].sort((x, y) => num(y) - num(x));
  }, [indexed, cbmStores]);

  if (!memory) return <div className="empty"><span className="spin" /> leyendo memorias…</div>;

  if (exploring) {
    return <GraphExplorer store={exploring} onClose={() => setExploring(null)} flash={flash} />;
  }

  const totalMemories = memory.claudeMemory.reduce((a, s) => a + s.entries.length, 0);

  return (
    <div className="grid" style={{ gap: 14 }}>
      {/* Codebase Memory: una sola lista, cruzando el indice del servidor con
          los artifacts exportados en cada repo */}
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.7, color: 'var(--muted)' }}>
            Codebase Memory
          </h3>
          <span className={'chip ' + (codebase.length ? 'on' : '')}>
            {indexed === null
              ? 'consultando…'
              : `${codebase.length} ${codebase.length === 1 ? 'proyecto' : 'proyectos'}`}
          </span>
          {indexed === null && <span className="spin" />}
        </div>

        {!codebase.length ? (
          <div className="card dim" style={{ fontSize: 12 }}>
            Ningún proyecto indexado todavía. Corré <code>index_repository</code> desde Claude Code.
          </div>
        ) : (
          <div className="grid g2">
            {codebase.map((e) => <CodebaseCard key={e.key} e={e} onExplore={setExploring} />)}
          </div>
        )}
      </div>

      {/* Graphify */}
      {graphify && (
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.7, color: 'var(--muted)' }}>
              Graphify
            </h3>
            <span className={'chip ' + (graphify.installed ? 'on' : '')}>
              {graphify.installed
                ? `${graphify.stores.length} ${graphify.stores.length === 1 ? 'repo indexado' : 'repos indexados'}`
                : 'no detectado'}
            </span>
            {graphify.global && (
              <span className="chip info">
                grafo global: {graphify.global.nodes == null
                  ? fmtBytes(graphify.global.sizeBytes)
                  : fmtInt(graphify.global.nodes) + ' nodos'}
              </span>
            )}
          </div>

          {!graphify.stores.length ? (
            <div className="card dim" style={{ fontSize: 12 }}>
              Graphify no está instalado en esta máquina. Cuando corras <code>graphify install</code> y
              generes un <code>graphify-out/</code> en algún repo, aparece acá solo.
            </div>
          ) : (
            <div className="grid g2">
              {graphify.stores.map((st) => <GraphStore key={st.dir} s={st} onExplore={setExploring} />)}
            </div>
          )}
        </div>
      )}

      {/* memoria de archivos de Claude Code */}
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.7, color: 'var(--muted)' }}>
            Memoria de Claude Code
          </h3>
          <span className="chip on">{totalMemories} recuerdos en {memory.claudeMemory.length} proyectos</span>
        </div>

        {!memory.claudeMemory.length ? (
          <div className="card dim">Todavía no hay archivos de memoria.</div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            {memory.claudeMemory.map((store) => (
              <div className="card" key={store.dir}>
                <div
                  className="row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setOpenStore(openStore === store.dir ? null : store.dir)}
                >
                  <b style={{ fontSize: 13 }} title={store.projectPath || store.projectDir}>
                    {store.projectPath ? basename(store.projectPath) : store.projectDir}
                  </b>
                  <span className="chip">{store.entries.length} memorias</span>
                  {store.index && <span className="chip info">MEMORY.md</span>}
                  <span className="right dim">{openStore === store.dir ? '▲' : '▼'}</span>
                </div>

                {openStore === store.dir && (
                  <div style={{ marginTop: 12 }}>
                    {store.entries.map((e) => (
                      <details key={e.path} style={{ marginBottom: 8 }}>
                        <summary className="row" style={{ gap: 8 }}>
                          <span className={'chip ' + (TYPE_CHIP[e.type] || '')}>{e.type}</span>
                          <b style={{ fontSize: 12.5 }}>{e.name}</b>
                          <span className="dim trunc" style={{ flex: 1, fontSize: 11.5 }}>{e.description}</span>
                          <span className="dim" style={{ fontSize: 11 }}>{fmtAgo(new Date(e.mtimeMs).toISOString())}</span>
                        </summary>
                        <div className="block" style={{ marginTop: 6 }}>{e.body}</div>
                        <div className="row wrap" style={{ gap: 5, marginTop: 4 }}>
                          {e.links.map((l) => <span key={l} className="chip alt" style={{ fontSize: 10 }}>→ {l}</span>)}
                          <button
                            className="btn sm right"
                            onClick={() => window.cockpit.revealPath(e.path)}
                          >
                            archivo
                          </button>
                        </div>
                      </details>
                    ))}

                    {store.index && (
                      <details style={{ marginTop: 10 }}>
                        <summary className="chip info">índice MEMORY.md</summary>
                        <div className="block" style={{ marginTop: 6 }}>{store.index.body}</div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card dim" style={{ fontSize: 11.5 }}>
        Hay tres cosas distintas que se llaman "memoria" y la app las separa a propósito:
        el <b>grafo de código</b> (codebase-memory / graphify, que indexa símbolos y llamadas),
        y la <b>memoria de Claude Code</b>, que son archivos markdown con hechos sobre vos y
        tus proyectos que Claude escribe y relee en cada sesión.
      </div>
    </div>
  );
}
