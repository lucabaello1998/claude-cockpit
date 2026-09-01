import React, { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtAgo } from '../util.js';
import { setShowCosts, useShowCosts } from '../money.js';

const FUENTE = {
  incluida: 'la tabla que trae la app',
  oficial: 'la documentación oficial de Anthropic',
  manual: 'valores que cargaste a mano',
  personalizada: 'una tabla propia',
};

export default function PricingPanel({ flash }) {
  const [info, setInfo] = useState(null);
  const [docUrl, setDocUrl] = useState('');
  const [remoto, setRemoto] = useState(null);
  const [editando, setEditando] = useState(null);
  const [busy, setBusy] = useState(false);
  const show = useShowCosts();

  const cargar = useCallback(async () => {
    const r = await window.cockpit.pricingInfo();
    setInfo(r.info);
    setDocUrl(r.docUrl);
    setShowCosts(r.showCosts);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const bajar = async () => {
    setBusy(true);
    try {
      setRemoto(await window.cockpit.pricingFetchRemote());
    } catch (e) {
      flash('No se pudo bajar la tabla: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const aplicarRemoto = async () => {
    setBusy(true);
    try {
      const t = Object.assign({}, remoto.tabla, { source: 'oficial' });
      setInfo(await window.cockpit.pricingApply(t));
      setRemoto(null);
      flash('Precios actualizados desde la documentación oficial');
    } catch (e) {
      flash('No se pudo aplicar: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const guardarManual = async () => {
    setBusy(true);
    try {
      const t = { models: {}, source: 'manual', fetchedAt: new Date().toISOString() };
      for (const [id, m] of Object.entries(editando)) {
        t.models[id] = {
          label: m.label,
          input: Number(m.input), output: Number(m.output),
          write5m: Number(m.write5m), write1h: Number(m.write1h), read: Number(m.read),
        };
      }
      setInfo(await window.cockpit.pricingApply(t));
      setEditando(null);
      flash('Precios guardados');
    } catch (e) {
      flash('No se pudo guardar: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const restablecer = async () => {
    setBusy(true);
    try {
      setInfo(await window.cockpit.pricingReset());
      setEditando(null); setRemoto(null);
      flash('Volviste a la tabla que trae la app');
    } catch (e) {
      flash('No se pudo restablecer: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const cambiarModo = async (v) => {
    setShowCosts(v);
    try { await window.cockpit.setShowCosts(v); } catch { /* queda en memoria */ }
  };

  if (!info) return <div className="card dim">Cargando…</div>;

  const modelos = Object.entries(editando || info.models);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <h3>Qué mostrar</h3>
        <div className="row" style={{ gap: 6, marginBottom: 10 }}>
          <button
            className={'btn sm' + (show ? ' primary' : '')}
            onClick={() => cambiarModo(true)}
            title="Estima cuánto costaría el mismo tráfico a tarifa API"
          >
            Costo en dólares
          </button>
          <button
            className={'btn sm' + (!show ? ' primary' : '')}
            onClick={() => cambiarModo(false)}
            title="Solo tokens: salen del transcript, son exactos y no dependen de ninguna tabla"
          >
            Solo tokens
          </button>
        </div>
        <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
          Los <b>tokens son exactos</b>: los reporta la API en cada respuesta y quedan en el
          transcript. El <b>costo es siempre una estimación</b>, por tres motivos: tu cuenta es por
          suscripción y no se factura por token, la tabla de precios puede quedar vieja, y en
          Bedrock o Vertex las tarifas son distintas. Si el número en dólares te confunde más de lo
          que te sirve, apagalo y mirá tokens.
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Tabla de precios</h3>
          <span className={'chip ' + (info.source === 'incluida' ? '' : 'info')}>
            {FUENTE[info.source] || info.source}
          </span>
          {info.fetchedAt && (
            <span className="chip dim" title={fmtDate(info.fetchedAt)}>
              {info.source === 'incluida' ? 'del ' + info.fetchedAt : fmtAgo(info.fetchedAt)}
            </span>
          )}
          <div className="right row" style={{ gap: 6 }}>
            <button className="btn sm primary" onClick={bajar} disabled={busy}>
              {busy ? '…' : 'Buscar precios actualizados'}
            </button>
            {!editando && (
              <button className="btn sm" onClick={() => setEditando(JSON.parse(JSON.stringify(info.models)))}>
                Editar a mano
              </button>
            )}
            {info.source !== 'incluida' && (
              <button className="btn sm" onClick={restablecer} disabled={busy}>Restablecer</button>
            )}
          </div>
        </div>

        {remoto && (
          <div className="card" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>
            <b style={{ fontSize: 12.5 }}>
              {remoto.cambios.length
                ? `${remoto.cambios.length} ${remoto.cambios.length === 1 ? 'cambio' : 'cambios'} respecto de lo que tenés`
                : 'La tabla oficial coincide con la que ya tenés'}
            </b>
            {remoto.cambios.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Modelo</th><th>Ahora</th><th>Oficial</th></tr></thead>
                <tbody>
                  {remoto.cambios.map((c) => (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td className="dim">{c.de || '—'}</td>
                      <td><b>{c.a}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <button className="btn sm primary" onClick={aplicarRemoto} disabled={busy}>Aplicar</button>
              <button className="btn sm" onClick={() => setRemoto(null)}>Descartar</button>
              <span className="dim right" style={{ fontSize: 11 }}>{remoto.tabla.count} modelos leídos</span>
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Modelo</th>
              <th className="n">Input</th>
              <th className="n">Salida</th>
              <th className="n">Caché 5m</th>
              <th className="n">Caché 1h</th>
              <th className="n">Lectura</th>
            </tr>
          </thead>
          <tbody>
            {modelos.map(([id, m]) => (
              <tr key={id}>
                <td><b>{m.label}</b><div className="dim mono" style={{ fontSize: 10 }}>{id}</div></td>
                {['input', 'output', 'write5m', 'write1h', 'read'].map((campo) => (
                  <td className="n" key={campo}>
                    {editando ? (
                      <input
                        type="number" step="0.01" min="0"
                        value={m[campo]}
                        onChange={(e) => setEditando((prev) => ({
                          ...prev, [id]: { ...prev[id], [campo]: e.target.value },
                        }))}
                        style={{ width: 74, textAlign: 'right', padding: '2px 6px' }}
                      />
                    ) : '$' + m[campo]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {editando && (
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            <button className="btn sm primary" onClick={guardarManual} disabled={busy}>Guardar</button>
            <button className="btn sm" onClick={() => setEditando(null)}>Cancelar</button>
            <span className="dim right" style={{ fontSize: 11 }}>USD por millón de tokens</span>
          </div>
        )}

        <div className="dim" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
          <b style={{ color: 'var(--text)' }}>De dónde salen.</b> Anthropic no publica los precios en
          ningún formato consultable por programa: solo están en la documentación. "Buscar precios
          actualizados" lee{' '}
          <span className="mono" style={{ cursor: 'pointer', color: 'var(--blue)' }}
            onClick={() => window.cockpit.openExternal(docUrl)}>esa página oficial</span>{' '}
          y te muestra qué cambia antes de aplicar nada. No uso calculadoras de terceros: son el
          scrapeo que hizo otro de la misma página, y si se equivocan heredás el error creyéndole más.
          <br />
          Búsquedas web: ${info.webSearchPer1000} cada 1.000, y se cuentan aparte de los tokens.
        </div>
      </div>
    </div>
  );
}
