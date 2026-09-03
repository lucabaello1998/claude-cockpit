import React, { useCallback, useEffect, useState } from 'react';
import { fmtBytes } from '../util.js';
import { reconcileBeforeSave } from '../workflowGraph.js';
import WorkflowGraphEditor from './WorkflowGraphEditor.jsx';

const COLOR = { parallel: 'var(--blue)', pipeline: 'var(--purple)', secuencial: 'var(--accent)' };
const AYUDA = {
  parallel: 'Corre junto con los otros de su grupo; el paso siguiente espera a todos.',
  pipeline: 'Encadenado: sigue en cuanto este item está listo, sin esperar a los demás.',
  secuencial: 'Corre solo, uno después del otro.',
};

// Diagrama por capas: una columna por etapa, los agentes apilados adentro.
// No es force-directed a propósito: un workflow tiene orden, y un grafo con
// física lo dibujaría como una nube sin dirección.
function Diagrama({ a }) {
  const fases = a.fases.filter((f) => f.agentes.length || f.usada || f.declarada);
  if (!fases.length && !a.agentes.length) {
    return <div className="dim" style={{ fontSize: 12 }}>No encontré etapas ni agentes en este archivo.</div>;
  }

  return (
    <div>
      <div className="tablero" style={{ alignItems: 'stretch' }}>
        {fases.map((f, i) => (
          <React.Fragment key={f.titulo}>
            <div className="columna" style={{ flex: '0 0 220px' }}>
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                <b style={{ fontSize: 12 }}>{f.titulo}</b>
                <span className="chip dim" style={{ fontSize: 10 }}>{f.agentes.length}</span>
                {!f.declarada && (
                  <span className="chip warn" style={{ fontSize: 9.5 }} title="Se usa en el código pero no está en meta.phases">
                    sin declarar
                  </span>
                )}
                {!f.usada && (
                  <span className="chip warn" style={{ fontSize: 9.5 }} title="Está en meta.phases pero nunca se llama a phase() con ese título">
                    sin usar
                  </span>
                )}
              </div>
              {f.agentes.map((ag, j) => (
                <div
                  key={j}
                  className="tarjeta"
                  style={{ borderLeftColor: COLOR[ag.concurrencia], cursor: 'default' }}
                  title={AYUDA[ag.concurrencia] + '\nlínea ' + ag.linea}
                >
                  <div className="mono" style={{ fontSize: 11.5 }}>{ag.label}</div>
                  <div className="row wrap" style={{ gap: 3, marginTop: 4 }}>
                    <span className="chip" style={{ fontSize: 9, borderColor: COLOR[ag.concurrencia], color: COLOR[ag.concurrencia] }}>
                      {ag.concurrencia}
                    </span>
                    {ag.tieneSchema && <span className="chip on" style={{ fontSize: 9 }}>schema</span>}
                    {ag.effort && <span className="chip dim" style={{ fontSize: 9 }}>{ag.effort}</span>}
                    <span className="chip dim" style={{ fontSize: 9 }}>L{ag.linea}</span>
                  </div>
                </div>
              ))}
              {!f.agentes.length && <div className="dim" style={{ fontSize: 11 }}>sin agentes</div>}
            </div>
            {i < fases.length - 1 && (
              <div style={{ alignSelf: 'center', color: 'var(--dim)', fontSize: 20, padding: '0 2px' }}>→</div>
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        {Object.entries(COLOR).map(([k, c]) => (
          <span key={k} className="chip" style={{ fontSize: 10, borderColor: c }} title={AYUDA[k]}>
            <span style={{ width: 10, height: 3, background: c, display: 'inline-block' }} />{k}
          </span>
        ))}
        {a.usaArgs && <span className="chip info" style={{ fontSize: 10 }}>recibe args</span>}
        {a.sinFase > 0 && (
          <span className="chip warn" style={{ fontSize: 10 }} title="Agentes que no caen en ninguna etapa">
            {a.sinFase} sin etapa
          </span>
        )}
      </div>

      <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
        El diagrama sale de leer el código, no de ejecutarlo. Si el workflow arma agentes de forma
        dinámica —dentro de un <span className="mono">map</span> sobre algo que viene en{' '}
        <span className="mono">args</span>, por ejemplo— acá vas a ver uno solo donde en la práctica
        corren varios. Los labels armados por concatenación se marcan con <b>*</b>.
      </div>
    </div>
  );
}

function Tutorial({ pasos }) {
  const [i, setI] = useState(0);
  const p = pasos[i];
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Tutorial</h3>
        <span className="chip dim">{i + 1} de {pasos.length}</span>
        <div className="right row" style={{ gap: 6 }}>
          <button className="btn sm" disabled={!i} onClick={() => setI(i - 1)}>Anterior</button>
          <button className="btn sm primary" disabled={i >= pasos.length - 1} onClick={() => setI(i + 1)}>
            Siguiente
          </button>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 4, marginBottom: 12 }}>
        {pasos.map((x, j) => (
          <span
            key={j}
            onClick={() => setI(j)}
            className={'chip' + (j === i ? ' info' : '')}
            style={{ cursor: 'pointer', fontSize: 10 }}
          >
            {j + 1}
          </span>
        ))}
      </div>

      <b style={{ fontSize: 13.5 }}>{p.titulo}</b>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, margin: '8px 0' }}>{p.texto}</div>

      {p.codigo && (
        <div className="block" style={{ marginBottom: 8 }}>
          <pre style={{ fontSize: 11.5 }}>{p.codigo}</pre>
        </div>
      )}

      {p.ojo && (
        <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11.5 }}>
          {p.ojo}
        </div>
      )}
    </div>
  );
}

export default function WorkflowsPanel({ flash }) {
  const [datos, setDatos] = useState(null);
  const [abierto, setAbierto] = useState(null);
  const [vista, setVista] = useState('diagrama');
  const [borrador, setBorrador] = useState('');
  const [tutorial, setTutorial] = useState(false);
  const [busy, setBusy] = useState(false);
  // Se incrementa cada vez que el contenido "de verdad" cambia (Guardar,
  // Descartar): fuerza que el editor visual vuelva a leer desde cero en vez
  // de seguir mostrando un grafo que ya no corresponde al archivo.
  const [graphTick, setGraphTick] = useState(0);

  const cargar = useCallback(async () => {
    try { setDatos(await window.cockpit.workflowsList()); }
    catch (e) { flash('No se pudieron leer los workflows: ' + e.message, true); }
  }, [flash]);

  useEffect(() => { cargar(); }, [cargar]);

  const abrir = async (file) => {
    setBusy(true);
    try {
      const d = await window.cockpit.workflowRead(file);
      setAbierto(d);
      setBorrador(d.content);
      setVista('diagrama');
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  const correr = async (fn, msg) => {
    setBusy(true);
    try { await fn(); await cargar(); flash(msg); }
    catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  if (!datos) return <div className="card dim">Cargando…</div>;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Workflows ({datos.workflows.length})</h3>
          <button className={'btn sm' + (tutorial ? ' primary' : '')} onClick={() => setTutorial((v) => !v)}>
            {tutorial ? 'Cerrar tutorial' : 'Cómo se arma uno'}
          </button>
          <span className="dim right mono" style={{ fontSize: 10.5 }}>{datos.dir}</span>
        </div>

        {!datos.workflows.length && (
          <div className="dim" style={{ fontSize: 12 }}>
            No tenés ninguno. Empezá por una plantilla de abajo.
          </div>
        )}

        {datos.workflows.map((w) => (
          <div key={w.file} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row" style={{ gap: 8 }}>
              <b style={{ fontSize: 12.5, minWidth: 150 }}>{w.name}</b>
              <span className="mono dim" style={{ fontSize: 10.5 }}>{w.file}</span>
              <span className="chip dim" style={{ fontSize: 10 }}>{w.fases} etapas</span>
              <span className="chip dim" style={{ fontSize: 10 }}>{w.agentes} agentes</span>
              {!w.tieneMeta && (
                <span className="chip bad" style={{ fontSize: 10 }} title="Sin export const meta, el workflow no se puede invocar">
                  sin meta
                </span>
              )}
              <span className="dim" style={{ fontSize: 10.5 }}>{fmtBytes(w.bytes)}</span>
              <button className="btn sm right" onClick={() => abrir(w.file)}>Abrir</button>
            </div>
            {w.description && (
              <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>{w.description}</div>
            )}
          </div>
        ))}
      </div>

      {tutorial && <Tutorial pasos={datos.tutorial} />}

      {abierto && (
        <div className="card">
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            <b style={{ fontSize: 13.5 }}>{abierto.analisis.name || abierto.file}</b>
            <span className="mono dim" style={{ fontSize: 10.5 }}>{abierto.file}</span>
            <button className={'btn sm' + (vista === 'diagrama' ? ' primary' : '')} onClick={() => setVista('diagrama')}>
              Diagrama
            </button>
            <button className={'btn sm' + (vista === 'grafico' ? ' primary' : '')} onClick={() => setVista('grafico')}>
              Editor visual
            </button>
            <button className={'btn sm' + (vista === 'codigo' ? ' primary' : '')} onClick={() => setVista('codigo')}>
              Código
            </button>
            <div className="right row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => window.cockpit.revealPath(abierto.path)}>Ver archivo</button>
              <button className="btn sm" onClick={() => { setAbierto(null); setBorrador(''); }}>Cerrar</button>
            </div>
          </div>

          {abierto.analisis.whenToUse && (
            <div className="block" style={{ marginBottom: 10, fontSize: 11.5 }}>
              <span className="dim">Cuándo usarlo: </span>{abierto.analisis.whenToUse}
            </div>
          )}

          {vista === 'diagrama' && <Diagrama a={abierto.analisis} />}

          {/* No se desmonta al cambiar de pestaña (solo se oculta), para no perder
              el layout del grafo a mitad de edición. Se resetea con la key cuando
              se abre otro archivo o cuando el contenido guardado cambia de verdad. */}
          <div style={{ display: vista === 'grafico' ? 'block' : 'none' }}>
            <WorkflowGraphEditor
              key={abierto.file + ':' + graphTick}
              content={borrador}
              analisis={abierto.analisis}
              active={vista === 'grafico'}
              onGenerate={(src) => { setBorrador(src); setVista('codigo'); }}
            />
          </div>

          {vista === 'codigo' && (
            <>
              <textarea
                value={borrador}
                onChange={(e) => setBorrador(e.target.value)}
                style={{ width: '100%', minHeight: 420, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
              />
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <button
                  className="btn sm primary" disabled={busy || borrador === abierto.content}
                  onClick={() => {
                    const { content, graphDropped } = reconcileBeforeSave(borrador);
                    correr(async () => {
                      const d = await window.cockpit.workflowSave(abierto.file, content);
                      setAbierto(d); setBorrador(d.content); setGraphTick((t) => t + 1);
                    }, graphDropped
                      ? 'Workflow guardado como código plano: la edición manual invalidó el diagrama generado.'
                      : 'Workflow guardado');
                  }}
                >
                  Guardar
                </button>
                <button
                  className="btn sm" disabled={borrador === abierto.content}
                  onClick={() => { setBorrador(abierto.content); setGraphTick((t) => t + 1); }}
                >
                  Descartar cambios
                </button>
                <button
                  className="btn sm right" disabled={busy}
                  onClick={() => {
                    if (!window.confirm('¿Borrar ' + abierto.file + '?')) return;
                    correr(() => window.cockpit.workflowDelete(abierto.file), 'Workflow borrado')
                      .then(() => { setAbierto(null); setBorrador(''); });
                  }}
                >
                  Borrar
                </button>
                <span className="dim" style={{ fontSize: 11 }}>
                  Valida que tenga meta con name antes de escribir · deja un .bak
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3>Ejemplos listos para usar</h3>
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 10 }}>
          Cada uno resuelve un caso concreto y enseña una construcción distinta. Se crean en{' '}
          <span className="mono">~/.claude/workflows</span> y podés editarlos después.
        </div>
        <div className="grid g3" style={{ gap: 10 }}>
          {datos.plantillas.map((p) => (
            <div key={p.id} className="card" style={{ background: 'var(--panel-2)', padding: '11px 13px' }}>
              <b style={{ fontSize: 12.5 }}>{p.titulo}</b>
              <div className="dim" style={{ fontSize: 11.5, margin: '4px 0 8px', lineHeight: 1.6 }}>{p.para}</div>
              <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
                {p.ensena.map((e) => <span key={e} className="chip info" style={{ fontSize: 9.5 }}>{e}</span>)}
                <span className="chip dim" style={{ fontSize: 9.5 }}>{p.agentes}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn sm primary" disabled={busy || datos.workflows.some((w) => w.file === p.file)}
                  onClick={() => correr(async () => {
                    const d = await window.cockpit.workflowSave(p.file, p.codigo);
                    setAbierto(d); setBorrador(d.content); setVista('diagrama');
                  }, 'Creado ' + p.file)}
                >
                  {datos.workflows.some((w) => w.file === p.file) ? 'Ya lo tenés' : 'Crear'}
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setAbierto({ file: p.file, path: '(sin guardar)', content: p.codigo, analisis: p.analisis });
                    setBorrador(p.codigo); setVista('diagrama');
                  }}
                >
                  Ver
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Un workflow gasta en serio.</b> Cada{' '}
        <span className="mono">agent()</span> es un Claude aparte con su propio contexto: cinco
        agentes cuestan aproximadamente cinco veces. Conviene ponerle techo a lo que venga en{' '}
        <span className="mono">args</span> y usar <span className="mono">effort: 'low'</span> en los
        agentes que solo leen.
        <br /><br />
        Los workflows se invocan desde Claude Code, no desde acá: esta pestaña es para escribirlos,
        entenderlos y verlos dibujados.
      </div>
    </div>
  );
}
