import React, { useCallback, useEffect, useState } from 'react';
import { fmtBytes, fmtAgo } from '../util.js';

const VACIA = { archivo: 'settings.json', evento: 'PostToolUse', matcher: '', command: '', timeout: '' };

export default function HooksPanel({ flash }) {
  const [datos, setDatos] = useState(null);
  const [form, setForm] = useState(null);
  const [editando, setEditando] = useState(null);
  const [script, setScript] = useState(null);
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    try { setDatos(await window.cockpit.hooksList()); }
    catch (e) { flash('No se pudieron leer los hooks: ' + e.message, true); }
  }, [flash]);

  useEffect(() => { cargar(); }, [cargar]);

  const correr = async (fn, msg) => {
    setBusy(true);
    try { await fn(); await cargar(); flash(msg); }
    catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  if (!datos) return <div className="card dim">Cargando…</div>;

  const evento = (id) => datos.eventos.find((e) => e.id === id) || {};

  const Formulario = ({ valor, setValor, titulo, onGuardar, onCancelar }) => {
    const ev = evento(valor.evento);
    return (
      <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
        <b style={{ fontSize: 12.5 }}>{titulo}</b>
        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
          <select
            value={valor.evento} disabled={!!editando}
            onChange={(e) => setValor({ ...valor, evento: e.target.value })}
            style={{ fontSize: 11.5 }}
          >
            {datos.eventos.map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
          </select>
          <input
            type="text"
            placeholder={ev.usaMatcher ? `matcher: ${ev.ejemploMatcher || 'regex'}` : 'este evento no usa matcher'}
            value={valor.matcher} disabled={!ev.usaMatcher}
            onChange={(e) => setValor({ ...valor, matcher: e.target.value })}
            style={{ width: 190, fontSize: 11.5 }}
          />
          <input
            type="number" min="1" placeholder="timeout (s)"
            value={valor.timeout}
            onChange={(e) => setValor({ ...valor, timeout: e.target.value })}
            style={{ width: 110, fontSize: 11.5 }}
          />
          {!editando && (
            <select
              value={valor.archivo}
              onChange={(e) => setValor({ ...valor, archivo: e.target.value })}
              style={{ fontSize: 11.5 }}
            >
              <option value="settings.json">settings.json (siempre)</option>
              <option value="settings.local.json">settings.local.json (solo acá)</option>
            </select>
          )}
        </div>
        <div className="dim" style={{ fontSize: 11, margin: '6px 0' }}>
          {ev.desc}
          {ev.usaMatcher && ` · el matcher es una expresión regular contra el ${ev.matcherDe}`}
        </div>
        <textarea
          placeholder="comando de shell…"
          value={valor.command}
          onChange={(e) => setValor({ ...valor, command: e.target.value })}
          style={{ width: '100%', minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
        />
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button className="btn sm primary" disabled={busy || !valor.command.trim()} onClick={onGuardar}>
            Guardar
          </button>
          <button className="btn sm" onClick={onCancelar}>Cancelar</button>
          <span className="dim right" style={{ fontSize: 11 }}>
            Salir con código 2 en un PreToolUse bloquea la herramienta
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Reglas ({datos.reglas.length})</h3>
          <button
            className="btn sm right"
            onClick={() => { setForm({ ...VACIA }); setEditando(null); }}
          >
            Agregar regla
          </button>
        </div>

        {form && (
          <Formulario
            valor={form} setValor={setForm} titulo="Regla nueva"
            onCancelar={() => setForm(null)}
            onGuardar={() => correr(() => window.cockpit.hookAdd(form), 'Hook agregado').then(() => setForm(null))}
          />
        )}

        {!datos.reglas.length && !form && (
          <div className="dim" style={{ fontSize: 12 }}>Sin hooks configurados.</div>
        )}

        {datos.reglas.map((r) => (
          <div key={r.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="chip info" style={{ fontSize: 10 }} title={evento(r.evento).desc}>{r.evento}</span>
              {r.matcher && <span className="mono" style={{ fontSize: 11 }}>{r.matcher}</span>}
              <span className="mono dim trunc" style={{ flex: 1, fontSize: 11 }} title={r.command}>{r.command}</span>
              {r.timeout && <span className="chip dim" style={{ fontSize: 10 }}>{r.timeout}s</span>}
              <span className="chip dim" style={{ fontSize: 10 }}>{r.archivo}</span>
              <button
                className="btn sm"
                onClick={() => {
                  setForm(null);
                  setEditando({
                    id: r.id, archivo: r.archivo, evento: r.evento,
                    matcher: r.matcher, command: r.command, timeout: r.timeout || '',
                  });
                }}
              >
                Editar
              </button>
              <button
                className="btn sm" disabled={busy}
                onClick={() => correr(() => window.cockpit.hookDelete(r.id), 'Hook eliminado')}
              >
                Quitar
              </button>
            </div>
            {editando && editando.id === r.id && (
              <Formulario
                valor={editando} setValor={setEditando} titulo={'Editar · ' + r.evento}
                onCancelar={() => setEditando(null)}
                onGuardar={() => correr(
                  () => window.cockpit.hookEdit(editando.id, {
                    matcher: editando.matcher, command: editando.command, timeout: editando.timeout,
                  }),
                  'Hook actualizado'
                ).then(() => setEditando(null))}
              />
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Plantillas</h3>
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 10 }}>
          Cargan el formulario con todo listo; podés ajustarlo antes de guardar.
        </div>
        <div className="grid g2" style={{ gap: 8 }}>
          {datos.plantillas.map((p) => (
            <div key={p.id} className="card" style={{ background: 'var(--panel-2)', padding: '10px 12px' }}>
              <div className="row" style={{ gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>{p.titulo}</b>
                <span className="chip info" style={{ fontSize: 10 }}>{p.evento}</span>
                <button
                  className="btn sm right"
                  onClick={() => {
                    setEditando(null);
                    setForm({
                      archivo: 'settings.json', evento: p.evento, matcher: p.matcher,
                      command: p.command, timeout: String(p.timeout || ''),
                    });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Usar
                </button>
              </div>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>{p.para}</div>
              <div className="mono dim trunc" style={{ fontSize: 10.5, marginTop: 4 }} title={p.command}>
                {p.command}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Scripts ({datos.scripts.length})</h3>
          <span className="dim right mono" style={{ fontSize: 10.5 }}>{datos.dirScripts}</span>
        </div>
        {!datos.scripts.length && <div className="dim" style={{ fontSize: 12 }}>Ninguno.</div>}
        {datos.scripts.map((s) => (
          <div key={s.name} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row" style={{ gap: 8 }}>
              <b className="mono" style={{ fontSize: 12 }}>{s.name}</b>
              <span className="chip dim" style={{ fontSize: 10 }}>{fmtBytes(s.bytes)}</span>
              <span className="dim" style={{ fontSize: 10.5 }}>{fmtAgo(new Date(s.mtimeMs).toISOString())}</span>
              {!s.usado && (
                <span className="chip warn" style={{ fontSize: 10 }} title="Ninguna regla lo referencia: nunca se ejecuta">
                  sin usar
                </span>
              )}
              <button
                className="btn sm right"
                onClick={() => window.cockpit.hookScriptRead(s.name).then(setScript)}
              >
                Editar
              </button>
            </div>
          </div>
        ))}
      </div>

      {script && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ width: 820, maxWidth: '95vw', maxHeight: '92vh', overflow: 'auto' }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <b className="mono" style={{ fontSize: 13 }}>{script.name}</b>
              <button className="btn sm right" onClick={() => window.cockpit.revealPath(script.path)}>
                Ver archivo
              </button>
            </div>
            <textarea
              value={script.content}
              onChange={(e) => setScript({ ...script, content: e.target.value })}
              style={{ width: '100%', minHeight: 380, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
            />
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button
                className="btn primary" disabled={busy}
                onClick={() => correr(
                  () => window.cockpit.hookScriptSave(script.name, script.content),
                  'Script guardado'
                ).then(() => setScript(null))}
              >
                Guardar
              </button>
              <button className="btn" onClick={() => setScript(null)}>Cancelar</button>
              <span className="dim right" style={{ fontSize: 11 }}>Se guarda una copia .bak al lado</span>
            </div>
          </div>
        </div>
      )}

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Cómo funcionan.</b> Un hook es un comando de shell que
        Claude Code ejecuta en un momento del ciclo. Recibe contexto por variables de entorno
        (<span className="mono">$CLAUDE_FILE_PATHS</span>, <span className="mono">$CLAUDE_TOOL_INPUT</span>)
        y su salida vuelve a la conversación.
        <br /><br />
        En <span className="mono">PreToolUse</span>, salir con <b>código 2</b> bloquea la herramienta
        y le explica a Claude por qué: es la forma de poner barreras duras, como impedir que se
        escriba en un <span className="mono">.env</span>.
        <br /><br />
        <b style={{ color: 'var(--text)' }}>Un hook corre con tus permisos.</b> Es código que se
        ejecuta solo, sin preguntarte. Revisá bien lo que pegás acá, sobre todo si viene de otro lado.
        Los cambios se escriben en settings.json con backup previo; reiniciá Claude Code para que los tome.
      </div>
    </div>
  );
}
