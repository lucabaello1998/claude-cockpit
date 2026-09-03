import React, { useCallback, useEffect, useState } from 'react';

// Aviso de version nueva de la app.
//
// No se instala sola a proposito: toda la app funciona con la regla de que
// nada se escribe sin que lo confirmes, y reiniciarse sola mientras leés una
// conversación sería justo lo contrario. Avisa, y vos decidís cuándo.

export default function Actualizacion({ flash }) {
  const [e, setE] = useState(null);
  const [busy, setBusy] = useState(false);

  const refrescar = useCallback(() => {
    window.cockpit.updaterState().then(setE).catch(() => setE(null));
  }, []);

  useEffect(() => {
    refrescar();
    // El main avisa solo cuando cambia (progreso de descarga, error, etc.).
    return window.cockpit.onUpdater(setE);
  }, [refrescar]);

  if (!e) return null;

  const buscar = async () => {
    setBusy(true);
    try { setE(await window.cockpit.updaterCheck()); }
    catch (err) { flash(String(err.message || err), true); }
    finally { setBusy(false); }
  };

  const descargar = async () => {
    setBusy(true);
    try { await window.cockpit.updaterDownload(); }
    catch (err) { flash(String(err.message || err).replace(/^Error:\s*/, ''), true); }
    finally { setBusy(false); }
  };

  const instalar = async () => {
    try { await window.cockpit.updaterInstall(); }
    catch (err) { flash(String(err.message || err), true); }
  };

  // En desarrollo no hay nada que actualizar; se dice y no se ocupa lugar.
  if (!e.soportado) {
    return (
      <div className="card dim" style={{ fontSize: 11, lineHeight: 1.6 }}>
        Versión <b>{e.version}</b>. {e.motivo}
      </div>
    );
  }

  const hay = !!e.disponible;

  return (
    <div
      className="card"
      style={hay ? { borderColor: 'var(--accent)', borderLeft: '3px solid var(--accent)' } : null}
    >
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {hay ? (
            <>
              <b style={{ fontSize: 13 }}>
                Hay una versión nueva: {e.disponible.version}
              </b>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>
                Estás en la {e.version}.
              </div>
              {e.disponible.notas && (
                <div
                  style={{
                    fontSize: 12, marginTop: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    maxHeight: 160, overflow: 'auto', overflowWrap: 'anywhere',
                  }}
                >
                  {e.disponible.notas}
                </div>
              )}
              {e.descargando && (
                <div style={{ marginTop: 10 }}>
                  <div className="meter-track">
                    <span className="fill" style={{ display: 'block', width: e.progreso + '%', height: '100%', background: 'var(--accent)' }} />
                  </div>
                  <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                    Descargando… {e.progreso}%
                  </div>
                </div>
              )}
              {e.descargada && (
                <div className="chip on" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11, marginTop: 10, lineHeight: 1.55 }}>
                  Descargada. Al instalar, la app se cierra y arranca el instalador.
                  Como no está firmado, Windows puede mostrarte el aviso de SmartScreen:
                  es el mismo que viste al instalarla la primera vez.
                </div>
              )}
            </>
          ) : (
            <>
              <b style={{ fontSize: 13 }}>Estás en la última versión ({e.version})</b>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>
                Se busca sola al abrir la app.
              </div>
            </>
          )}

          {e.error && (
            <div className="chip bad" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11, marginTop: 8 }}>
              {e.error}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 6 }}>
          {(busy || e.buscando) && <span className="spin" />}
          {hay && e.descargada && (
            <button className="btn sm primary" onClick={instalar}>Reiniciar e instalar</button>
          )}
          {hay && !e.descargada && !e.descargando && (
            <button className="btn sm primary" onClick={descargar} disabled={busy}>Descargar</button>
          )}
          {/* Siempre disponible, no solo cuando "no hay": una version que ya
              detecto puede quedar con metadata vieja en cache (paso, en la
              practica, mientras se corregia un release a medio publicar) y
              sin esto la unica forma de refrescarla era reiniciar la app. */}
          {!e.descargando && !e.descargada && (
            <button className="btn sm" onClick={buscar} disabled={busy || e.buscando} title="Volver a buscar (por si la versión detectada quedó con datos viejos)">
              Buscar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
