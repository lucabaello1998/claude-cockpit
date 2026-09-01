import React, { useCallback, useEffect, useState } from 'react';

// Que necesita la app y que falta.
//
// Nada de esto es obligatorio: sin ningun MCP la app igual muestra
// conversaciones, tokens, costos y memorias, que salen de leer archivos. Antes
// esto no se decia en ningun lado: si te faltaba el MCP de Azure DevOps, el
// boton de Boards aparecia gris y no habia forma de saber que faltaba.
//
// Se usa en dos lugares: al final del alta de primera vez (`compacto`) y como
// una seccion mas de Configuración.

function Campo({ campo, valor, onCambio }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label className="dim" style={{ fontSize: 11.5, display: 'block', marginBottom: 3 }}>
        {campo.label}
      </label>
      <input
        type={campo.secreto ? 'password' : 'text'}
        value={valor || ''}
        placeholder={campo.ejemplo || ''}
        onChange={(e) => onCambio(e.target.value)}
        style={{ width: '100%', fontSize: 12 }}
        autoComplete="off"
        spellCheck={false}
      />
      {campo.ayuda && (
        <div className="dim" style={{ fontSize: 10.5, marginTop: 3, lineHeight: 1.5 }}>{campo.ayuda}</div>
      )}
    </div>
  );
}

function Tarjeta({ r, onListo, flash }) {
  const [abierto, setAbierto] = useState(false);
  const [valores, setValores] = useState({});
  const [busy, setBusy] = useState(false);
  const [prueba, setPrueba] = useState(null);
  const [despues, setDespues] = useState(null);
  // Hay requisitos con mas de una implementacion (Jira). Se arranca sin elegir
  // para que la decision sea explicita.
  const opciones = r.opciones || [];
  const [opcion, setOpcion] = useState(opciones.length === 1 ? opciones[0].id : '');
  const elegida = opciones.find((o) => o.id === opcion) || null;
  const campos = elegida ? elegida.campos : (r.campos || []);

  const probar = async () => {
    setBusy(true); setPrueba(null);
    try {
      const x = await window.cockpit.reqTest(r.id);
      setPrueba({ ok: true, texto: x.detalle });
    } catch (e) {
      setPrueba({ ok: false, texto: String(e.message || e).replace(/^Error:\s*/, '') });
    } finally { setBusy(false); }
  };

  const guardar = async () => {
    setBusy(true); setPrueba(null); setDespues(null);
    try {
      const res = await window.cockpit.reqConfigure(r.id, valores, opcion || null);
      flash(r.titulo + ' configurado');
      setAbierto(false);
      setValores({});
      await onListo();
      // Algunos necesitan un paso mas afuera de la app (el OAuth del servidor
      // oficial de Atlassian lo corre Claude Code, no esta app).
      if (res && res.despues) { setDespues(res.despues); setBusy(false); return; }
      // Configurarlo no garantiza que ande: se prueba de una.
      await probar();
    } catch (e) {
      flash(String(e.message || e).replace(/^Error:\s*/, ''), true);
      setBusy(false);
    }
  };

  const completo = campos.every((c) => String(valores[c.id] || '').trim());

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <span className={'chip ' + (r.detectado ? 'on' : 'warn')} style={{ marginTop: 1 }}>
          {r.detectado ? 'listo' : 'falta'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 13 }}>{r.titulo}</b>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.55 }}>{r.habilita}</div>

          {r.detectado && (
            <div className="dim" style={{ fontSize: 10.5, marginTop: 5 }}>
              servidor <b>{r.servidor}</b> · alcance {r.alcance}
              {r.definidoPor && <> · lo define <span title={r.definidoPor}>{r.definidoPor.split(/[\\/]/).pop()}</span></>}
            </div>
          )}

          {!r.detectado && r.manual && (
            <div className="dim" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.55 }}>
              {r.manual}
              {(r.enlaces || []).map((e) => (
                <span key={e.url}>
                  {' '}
                  <a
                    href={e.url}
                    onClick={(ev) => { ev.preventDefault(); window.cockpit.openExternal(e.url); }}
                    style={{ color: 'var(--blue)' }}
                  >
                    {e.texto}
                  </a>
                </span>
              ))}
            </div>
          )}

          {abierto && opciones.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <div className="dim" style={{ fontSize: 11.5, marginBottom: 5 }}>
                Hay dos formas de conectarlo. Elegí una:
              </div>
              {opciones.map((o) => (
                <label
                  key={o.id}
                  className="card"
                  style={{
                    display: 'block', marginBottom: 6, cursor: 'pointer', padding: '8px 10px',
                    background: opcion === o.id ? 'var(--panel-2)' : 'transparent',
                    borderColor: opcion === o.id ? 'var(--accent)' : 'var(--line)',
                  }}
                >
                  <div className="row" style={{ gap: 7, alignItems: 'flex-start' }}>
                    <input
                      type="radio" name={'op-' + r.id} checked={opcion === o.id}
                      onChange={() => { setOpcion(o.id); setValores({}); }}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 12 }}>{o.titulo}</b>
                      <div className="dim" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>{o.resumen}</div>
                      {o.requiere && (
                        <div className="dim" style={{ fontSize: 10.5, marginTop: 3 }}>
                          Necesita tener instalado: {o.requiere}
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}

          {abierto && (elegida || campos.length > 0) && (
            <div style={{ marginTop: 10, maxWidth: 460 }}>
              {campos.map((c) => (
                <Campo
                  key={c.id} campo={c} valor={valores[c.id]}
                  onCambio={(v) => setValores({ ...valores, [c.id]: v })}
                />
              ))}
              {campos.some((c) => c.secreto) && (
                <div className="dim" style={{ fontSize: 10.5, marginBottom: 8, lineHeight: 1.5 }}>
                  El token se guarda en tu configuración de Claude Code, igual que si lo
                  agregaras a mano. No sale de esta máquina y nunca se incluye al exportar
                  tu setup.
                </div>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm primary" disabled={busy || !completo} onClick={guardar}>
                  {campos.length ? 'Guardar y probar' : 'Agregar'}
                </button>
                <button className="btn sm" onClick={() => setAbierto(false)}>Cancelar</button>
              </div>
            </div>
          )}

          {despues && (
            <div className="chip info" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11, marginTop: 8, lineHeight: 1.55 }}>
              {despues}
            </div>
          )}

          {prueba && (
            <div className={'chip ' + (prueba.ok ? 'on' : 'bad')}
              style={{ display: 'block', whiteSpace: 'normal', fontSize: 11, marginTop: 8 }}>
              {prueba.texto}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 6 }}>
          {busy && <span className="spin" />}
          {r.detectado && (
            <button className="btn sm" onClick={probar} disabled={busy} title="Pedirle datos de verdad al servidor">
              Probar
            </button>
          )}
          {!r.detectado && (opciones.length > 0 || (r.campos || []).length > 0) && !abierto && (
            <button className="btn sm primary" onClick={() => setAbierto(true)}>Configurar</button>
          )}
          {!r.detectado && !opciones.length && !(r.campos || []).length && (
            <button className="btn sm" onClick={probar} disabled={busy} title="Ver si ya lo tenés instalado">
              Revisar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Requisitos({ flash, compacto }) {
  const [lista, setLista] = useState(null);

  const cargar = useCallback(async () => {
    try { setLista(await window.cockpit.reqStatus()); }
    catch { setLista([]); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (!lista) return <div className="card dim">Revisando…</div>;

  const faltan = lista.filter((r) => !r.detectado).length;

  return (
    <div>
      {!compacto && (
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 12, lineHeight: 1.6, maxWidth: 640 }}>
          Nada de esto es obligatorio. Sin ningún servidor MCP la app igual te muestra
          las conversaciones, los tokens, los costos y las memorias, porque eso sale de
          leer tus archivos. Lo de acá abajo habilita lo que necesita hablar con un
          servicio de afuera.
        </div>
      )}

      {compacto && (
        <div style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
          {faltan === 0
            ? 'Tenés todo lo opcional configurado.'
            : `Hay ${faltan === 1 ? 'una cosa opcional' : faltan + ' cosas opcionales'} sin configurar. Podés hacerlo ahora o después, desde Configuración → Requisitos.`}
        </div>
      )}

      {lista.map((r) => <Tarjeta key={r.id} r={r} onListo={cargar} flash={flash} />)}
    </div>
  );
}
