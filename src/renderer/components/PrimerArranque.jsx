import React, { useCallback, useEffect, useState } from 'react';

// Qué mostrar cuando todavía no hay nada que mostrar.
//
// Antes, si Claude Code no estaba instalado, la app abría con todos los paneles
// vacíos. Eso no parece "te falta un paso": parece que la app está rota.
//
// Importante: esta app **no puede iniciarte sesión**. El login de Claude Code
// es un OAuth que corre el CLI y guarda el token en tu carpeta. Lo único
// honesto es detectar en qué punto estás y decirte exactamente qué hacer.

function Comando({ texto }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    } catch { /* sin portapapeles, se puede seleccionar a mano */ }
  };
  return (
    <div
      className="row"
      style={{
        gap: 8, background: 'var(--panel-2)', border: '1px solid var(--line)',
        borderRadius: 7, padding: '7px 10px', marginTop: 5,
      }}
    >
      <code style={{ flex: 1, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>{texto}</code>
      <button className="btn sm" onClick={copiar}>{copiado ? 'copiado' : 'copiar'}</button>
    </div>
  );
}

export default function PrimerArranque({ info, onListo }) {
  const [busy, setBusy] = useState(false);
  const [revisado, setRevisado] = useState(0);

  const revisar = useCallback(async () => {
    setBusy(true);
    try {
      const e = await window.cockpit.installState();
      if (e.estado === 'listo') onListo(e);
      else setRevisado((n) => n + 1);
    } catch { /* se reintenta a mano */ }
    finally { setBusy(false); }
  }, [onListo]);

  // Se revisa solo cada 5 segundos: lo normal es que dejes esta ventana abierta
  // mientras hacés el paso en la terminal, y queda raro tener que apretar algo.
  useEffect(() => {
    const id = setInterval(revisar, 5000);
    return () => clearInterval(id);
  }, [revisar]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div className="card" style={{ maxWidth: 620, width: '100%' }}>
        <div className="row" style={{ gap: 10, marginBottom: 14 }}>
          <span style={{
            width: 34, height: 34, borderRadius: 8, background: 'var(--accent)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
          }}>
            <span style={{ fontSize: 17 }}>▟</span>
          </span>
          <div>
            <b style={{ fontSize: 15 }}>{info.titulo}</b>
            <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>Claude Cockpit</div>
          </div>
        </div>

        <p style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--muted)', marginTop: 0 }}>
          {info.detalle}
        </p>

        {(info.pasos || []).map((p, i) => (
          <div key={i} style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5 }}>
              <b style={{ color: 'var(--accent)' }}>{i + 1}.</b> {p.texto}
            </div>
            {p.comando && <Comando texto={p.comando} />}
          </div>
        ))}

        <div className="row" style={{ gap: 8, marginTop: 18, alignItems: 'center' }}>
          <button className="btn primary" onClick={revisar} disabled={busy}>
            Ya lo hice, revisar
          </button>
          {busy && <span className="spin" />}
          {info.enlace && (
            <button className="btn" onClick={() => window.cockpit.openExternal(info.enlace)}>
              Ver la documentación
            </button>
          )}
        </div>

        <div className="dim" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
          Se revisa solo cada pocos segundos, así que podés dejar esta ventana abierta
          mientras lo hacés.
          {revisado > 0 && <> Todavía no encuentro nada; revisado {revisado} {revisado === 1 ? 'vez' : 'veces'}.</>}
        </div>

        <div className="dim" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.6, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          Claude Cockpit no reemplaza a Claude Code ni puede iniciarte sesión: lee lo que
          Claude Code deja en tu disco. El login lo hace el CLI y guarda el token en tu
          carpeta; esta app solo lo lee, y solo cuando le pedís actualizar el uso.
        </div>
      </div>
    </div>
  );
}
