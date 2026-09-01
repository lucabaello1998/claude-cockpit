import React, { useCallback, useEffect, useState } from 'react';
import { fmtInt, fmtBytes, fmtAgo } from '../util.js';

export default function SyncPanel({ snap, flash }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');

  const load = useCallback(async () => {
    const c = await window.cockpit.getSettings();
    setCfg(c);
    setLabel(c.machineLabel || '');
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setBusy(true);
    try {
      setCfg(await window.cockpit.setSettings(patch));
      flash('Configuración guardada');
    } catch (e) {
      flash('No se pudo guardar: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setBusy(true);
    try {
      const dir = await window.cockpit.pickSyncDir();
      if (dir) { await load(); flash('Carpeta de sincronización: ' + dir); }
    } catch (e) {
      flash('No se pudo elegir la carpeta: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <div className="card dim">Cargando…</div>;

  const machines = snap.machines || [];
  const errors = snap.remoteErrors || [];

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <h3>Máquinas ({machines.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Máquina</th>
              <th className="n">Sesiones</th>
              <th className="n">Requests</th>
              <th className="n">Transcripts</th>
              <th className="n">Actualizado</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => (
              <tr key={m.id}>
                <td>
                  <b>{m.label}</b>
                  <div className="dim mono" style={{ fontSize: 10.5 }}>{m.id}</div>
                </td>
                <td className="n">{fmtInt(m.sessions)}</td>
                <td className="n">{fmtInt(m.requests)}</td>
                <td className="n dim">{m.transcriptBytes ? fmtBytes(m.transcriptBytes) : '—'}</td>
                <td className="n dim">{fmtAgo(m.generatedAt)}</td>
                <td>
                  <span className={'chip ' + (m.isLocal ? 'on' : 'info')}>
                    {m.isLocal ? 'esta máquina' : 'sincronizada'}
                  </span>
                  {m.redacted && <span className="chip warn" style={{ marginLeft: 5 }}>anonimizada</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {errors.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {errors.map((e, i) => (
              <div key={i} className="chip bad" style={{ display: 'block', whiteSpace: 'normal', marginBottom: 5 }}>
                {e.machineLabel ? e.machineLabel + ': ' : ''}{e.error}
                {e.file && <span className="dim"> — {e.file}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Carpeta compartida</h3>

        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <span className="mono trunc" style={{ flex: 1, fontSize: 11.5, color: cfg.syncDir ? 'var(--text)' : 'var(--dim)' }}>
            {cfg.syncDir || 'sin configurar'}
          </span>
          <button className="btn sm primary" onClick={pick} disabled={busy}>Elegir carpeta…</button>
          {cfg.syncDir && (
            <button className="btn sm" onClick={() => save({ syncDir: null })} disabled={busy}>Desvincular</button>
          )}
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <span className="dim" style={{ width: 150, flex: '0 0 150px' }}>Nombre de esta máquina</span>
          <input
            type="text"
            value={label}
            placeholder={cfg.machineLabel}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== cfg.machineLabel && save({ machineLabel: label.trim() || null })}
            style={{ flex: 1 }}
          />
        </div>

        <label className="row" style={{ gap: 8, marginBottom: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={cfg.autoPublish}
            onChange={(e) => save({ autoPublish: e.target.checked })}
            disabled={busy}
          />
          <span>Publicar el digest después de cada reindexado</span>
        </label>

        <label className="row" style={{ gap: 8, marginBottom: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={cfg.redact}
            onChange={(e) => save({ redact: e.target.checked })}
            disabled={busy}
          />
          <span>
            Anonimizar
            <span className="dim"> — reemplaza títulos, rutas de proyecto y objetivos por un hash</span>
          </span>
        </label>

        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn sm"
            disabled={busy || !cfg.syncDir}
            onClick={async () => {
              try {
                const f = await window.cockpit.publishDigest();
                flash(f ? 'Digest publicado' : 'Configurá una carpeta primero', !f);
              } catch (e) { flash('Error al publicar: ' + e.message, true); }
            }}
          >
            Publicar ahora
          </button>
          {cfg.syncDir && (
            <button className="btn sm" onClick={() => window.cockpit.openPath(cfg.syncDir)}>Abrir carpeta</button>
          )}
        </div>
      </div>

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Qué se sincroniza y qué no.</b> Cada máquina deja un archivo
        <code> digest-&lt;id&gt;.json</code> en la carpeta (el tuyo pesa ~0,4 MB contra los{' '}
        {fmtBytes(snap.counts.diskBytes)} de transcripts). Adentro viajan contadores, tokens, costos,
        timestamps, nombres de proyecto y títulos de sesión.
        <br />
        <b style={{ color: 'var(--text)' }}>Nunca viaja el cuerpo de los mensajes</b> — ni tus prompts, ni las
        respuestas, ni los resultados de las herramientas. Por eso una sesión de otra máquina te muestra los
        números pero no se puede abrir para leerla: ese transcript se quedó allá.
        <br />
        Serví la carpeta con OneDrive, Syncthing o lo que uses. Cada máquina escribe solo su propio archivo,
        así que no hay conflictos. Los digests de otra cuenta de Claude se ignoran.
      </div>
    </div>
  );
}
