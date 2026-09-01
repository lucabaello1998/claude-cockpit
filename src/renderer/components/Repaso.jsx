import React, { useCallback, useEffect, useState } from 'react';
import { fmtAgo } from '../util.js';
import Actualizacion from './Actualizacion.jsx';

// El repaso del día.
//
// No gasta tokens: cada consejo sale de una regla sobre tus propios números, y
// las novedades del changelog público de Claude Code, filtradas contra la
// versión que estás usando.
//
// Ninguna regla dispara si no tiene algo real que decir. Un panel que siempre
// encuentra seis cosas se vuelve ruido y dejás de leerlo.

const CATEGORIAS = {
  pendientes: { label: 'Sin cerrar', color: '#d9b45b', orden: 0 },
  eficiencia: { label: 'Cómo venís gastando', color: '#d97757', orden: 1 },
  setup: { label: 'Podrías configurar', color: '#6c9fd8', orden: 2 },
};

export default function Repaso({ onIr, flash }) {
  const [datos, setDatos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cargar = useCallback(async (forzar) => {
    setBusy(true); setError(null);
    try { setDatos(await window.cockpit.briefing(!!forzar)); }
    catch (e) { setError(String(e.message || e).replace(/^Error:\s*/, '')); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { cargar(false); }, [cargar]);

  // El aviso de version nueva no depende del repaso: se muestra igual mientras
  // se arma, o si el repaso falla.
  const cabecera = <Actualizacion flash={flash} />;

  if (error) {
    return (
      <div className="grid" style={{ gap: 14 }}>
        {cabecera}
        <div className="card"><div className="empty">{error}</div></div>
      </div>
    );
  }
  if (!datos) {
    return (
      <div className="grid" style={{ gap: 14 }}>
        {cabecera}
        <div className="card dim">Revisando cómo venís…</div>
      </div>
    );
  }

  const items = datos.items || [];
  const grupos = Object.keys(CATEGORIAS)
    .sort((a, b) => CATEGORIAS[a].orden - CATEGORIAS[b].orden)
    .map((c) => ({ c, items: items.filter((i) => i.categoria === c) }))
    .filter((g) => g.items.length);

  const nov = datos.novedades;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {cabecera}

      <div className="row" style={{ gap: 8 }}>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {datos.generadoMs ? 'Armado ' + fmtAgo(new Date(datos.generadoMs).toISOString()) : ''}
          {datos.deCache ? ' · se rehace solo una vez por día' : ''}
        </span>
        {busy && <span className="spin" />}
        <button className="btn sm right" onClick={() => cargar(true)} disabled={busy}>
          Rehacer ahora
        </button>
      </div>

      {!items.length && (
        <div className="card">
          <b style={{ fontSize: 13 }}>No tengo nada que marcarte hoy</b>
          <div className="dim" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.6 }}>
            Ninguna de las reglas encontró algo que valga la pena decir: no hay work items tuyos
            frenados, el gasto viene parecido a la semana pasada y tu setup está completo.
            Prefiero decirte esto a inventarte consejos genéricos.
          </div>
        </div>
      )}

      {grupos.map((g) => (
        <div key={g.c}>
          <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 6 }}>
            {CATEGORIAS[g.c].label.toUpperCase()}
          </div>
          {g.items.map((i) => (
            <div
              key={i.id}
              className="card"
              style={{ marginBottom: 8, borderLeft: '3px solid ' + CATEGORIAS[g.c].color }}
            >
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 13 }}>{i.titulo}</b>
                  <div className="dim" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.65 }}>{i.texto}</div>
                </div>
                {i.ir && (
                  <button className="btn sm" onClick={() => onIr(i.ir)}>Ir</button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {nov && (
        <div>
          <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 6 }}>
            NOVEDADES DE CLAUDE CODE
          </div>
          <div className="card">
            {nov.versionesNuevas > 0 ? (
              <>
                <b style={{ fontSize: 13 }}>
                  Estás en la {nov.tuya} y salieron {nov.versionesNuevas} versión
                  {nov.versionesNuevas > 1 ? 'es' : ''} desde entonces
                </b>
                <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>
                  La última es la {nov.ultima}. Lo que agrega funcionalidad va primero.
                </div>
                <div style={{ marginTop: 10 }}>
                  {nov.destacado.map((d, k) => (
                    <div key={k} className="row" style={{ gap: 8, alignItems: 'flex-start', padding: '5px 0' }}>
                      <span className="chip dim" style={{ fontSize: 9.5, flex: '0 0 auto' }}>{d.version}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
                        {d.texto}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <b style={{ fontSize: 13 }}>Estás al día con Claude Code</b>
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                  Tu versión ({nov.tuya || '—'}) es la última publicada.
                </div>
              </>
            )}
            <div className="dim" style={{ fontSize: 10.5, marginTop: 10 }}>
              Sale del changelog oficial y se filtra contra tu versión, no contra la última.
            </div>
          </div>
        </div>
      )}

      <div className="card dim" style={{ fontSize: 11, lineHeight: 1.6 }}>
        Esto no consume tokens de tu cuenta. Los consejos salen de reglas sobre tus propios
        números y las novedades de una URL pública. No hay ningún modelo generando nada acá.
      </div>
    </div>
  );
}
