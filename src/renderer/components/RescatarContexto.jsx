import React, { useCallback, useEffect, useState } from 'react';

// Rescatar lo que aprendiste en una conversación antes de que se pierda.
//
// Dos caminos, y el segundo es el bueno:
//
//   1. Materia prima: tus propios mensajes que parecen decisiones. Sale de
//      expresiones regulares, así que encuentra sobre todo PEDIDOS, no
//      decisiones. Sirve para copiar y pegar algo puntual, no mucho más.
//
//   2. Pedírselo a Claude Code, que sí tiene modelo y ya sabe escribir memorias
//      en el formato que después lee. Cockpit arma el pedido con la ruta del
//      transcript y la carpeta destino; vos lo pegás en tu terminal.
//
// Cockpit no puede hacer el punto 2 por su cuenta: no tiene modelo, y usar tu
// token de Claude Code para inferencia por atrás sería gastarte la cuota sin
// que lo veas.

function Copiable({ texto, etiqueta }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      className="btn sm primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 1800);
        } catch { /* sin portapapeles */ }
      }}
    >
      {copiado ? 'copiado' : etiqueta}
    </button>
  );
}

export default function RescatarContexto({ sesion, onCerrar, flash }) {
  const [vista, setVista] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [cands, setCands] = useState(null);
  const [elegidos, setElegidos] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const proyecto = sesion && sesion.projectKey;

  useEffect(() => {
    window.cockpit.contextPrompt({ file: sesion.file }, proyecto)
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, [sesion, proyecto]);

  const cargarCandidatos = useCallback(async () => {
    if (cands) return;
    setBusy(true);
    try { setCands(await window.cockpit.contextCandidates(sesion.file)); }
    catch (e) { flash(String(e.message || e), true); setCands([]); }
    finally { setBusy(false); }
  }, [cands, sesion, flash]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCerrar]);

  const texto = (cands || []).filter((c) => elegidos.has(c.i))
    .map((c) => '- ' + c.texto.replace(/\s+/g, ' ')).join('\n');

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div className="card" style={{ width: 700, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}>
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <b style={{ fontSize: 14, flex: 1 }}>Que esto no se pierda</b>
          <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
        </div>
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.6 }}>
          Cuando esta sesión se compacte, cierres, o te vayas a otra máquina, se pierde
          lo que aprendimos acá. Claude Code lee solo las memorias del proyecto al
          arrancar: la idea es dejar ahí lo que importa.
        </div>

        <div className="row" style={{ gap: 6, marginBottom: 12 }}>
          <button
            className={'btn sm' + (vista === 'claude' ? ' primary' : '')}
            onClick={() => setVista('claude')}
          >
            Pedírselo a Claude Code
          </button>
          <button
            className={'btn sm' + (vista === 'crudo' ? ' primary' : '')}
            onClick={() => { setVista('crudo'); cargarCandidatos(); }}
          >
            Ver mis mensajes
          </button>
          {busy && <span className="spin" />}
        </div>

        {vista === 'claude' && (
          <>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 8 }}>
              Copiá esto y pegalo en Claude Code, en una sesión de ese proyecto.
              Él lee el transcript y escribe las memorias donde corresponde.
            </div>
            <pre style={{
              background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 7,
              padding: 12, fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto', margin: 0,
            }}>
              {prompt}
            </pre>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <Copiable texto={prompt} etiqueta="Copiar el pedido" />
              {sesion.cwd && (
                <button className="btn sm" onClick={() => window.cockpit.openPath(sesion.cwd)}>
                  Abrir el proyecto
                </button>
              )}
            </div>
            <div className="dim" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.55 }}>
              Cockpit no lo hace solo porque no tiene modelo. Usar tu token de Claude Code
              para inferencia por atrás sería gastarte la cuota sin que lo veas; así lo
              corrés vos y lo ves.
            </div>
          </>
        )}

        {vista === 'crudo' && (
          <>
            <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11, marginBottom: 10, lineHeight: 1.55 }}>
              Esto sale de buscar palabras, no de entender. Probado contra una sesión
              real, lo que encuentra son sobre todo <b>pedidos</b> ("estaría bueno
              que…"), no decisiones. Sirve para copiar algo puntual; para lo bueno, usá
              la otra pestaña.
            </div>
            {!cands ? <div className="dim">Buscando…</div> : !cands.length ? (
              <div className="dim" style={{ fontSize: 12 }}>No encontré nada que parezca una decisión.</div>
            ) : (
              <>
                {cands.map((c) => (
                  <label
                    key={c.i}
                    className="row"
                    style={{ gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--line-soft)', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={elegidos.has(c.i)}
                      onChange={() => {
                        const n = new Set(elegidos);
                        if (n.has(c.i)) n.delete(c.i); else n.add(c.i);
                        setElegidos(n);
                      }}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{c.texto}</div>
                      <div className="dim" style={{ fontSize: 10, marginTop: 2 }}>{c.porQue.join(' · ')}</div>
                    </div>
                  </label>
                ))}
                {elegidos.size > 0 && (
                  <div className="row" style={{ gap: 8, marginTop: 12 }}>
                    <Copiable texto={texto} etiqueta={`Copiar ${elegidos.size} seleccionado${elegidos.size > 1 ? 's' : ''}`} />
                    <span className="dim" style={{ fontSize: 11 }}>
                      Pegalo en una memoria desde Memorias → Qué recuerda Claude
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
