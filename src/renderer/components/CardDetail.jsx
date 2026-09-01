import React, { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtAgo } from '../util.js';

// Panel de detalle de una tarjeta. Sirve para las dos fuentes:
//
//   - Azure DevOps: el detalle se pide al abrir (descripcion, criterios de
//     aceptacion, comentarios, relaciones) y editar escribe en el board real.
//   - Tablero propio: ya esta todo en memoria y se guarda en disco.
//
// Todo lo que viene de ADO llega como TEXTO PLANO desde el main: las
// descripciones y comentarios son HTML escrito por otras personas y se
// convierten antes de cruzar el IPC, asi que aca nunca se usa
// dangerouslySetInnerHTML.

const NIVEL_COLOR = {
  hito: '#a98bd4', feature: '#6c9fd8', pbi: '#d97757', task: '#7cae7a',
};

function Campo({ k, v }) {
  if (v == null || v === '') return null;
  return (
    <div className="row" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
      <span className="dim" style={{ flex: '0 1 130px', fontSize: 11.5, overflowWrap: 'anywhere' }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  );
}

export default function CardDetail({
  tarjeta, remoto, proyecto, boardId, responsables, sprints, columnas,
  onCerrar, onCambio, flash,
}) {
  const [detalle, setDetalle] = useState(remoto ? null : tarjeta);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [comentario, setComentario] = useState('');
  const [estadosPosibles, setEstadosPosibles] = useState(null);

  const idTarjeta = tarjeta && tarjeta.id;

  // El detalle remoto se pide al abrir: la tarjeta del tablero solo trae lo
  // que entra en el WIQL.
  useEffect(() => {
    let vivo = true;
    if (!remoto) { setDetalle(tarjeta); return undefined; }
    setDetalle(null); setError(null);
    window.cockpit.adoDetail(proyecto, idTarjeta)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => { if (vivo) setError(String(e.message || e).replace(/^Error:\s*/, '')); });
    return () => { vivo = false; };
  }, [remoto, proyecto, idTarjeta, tarjeta]);

  // Los estados posibles dependen del tipo de work item.
  useEffect(() => {
    let vivo = true;
    if (!remoto || !tarjeta || !tarjeta.tipoOriginal) { setEstadosPosibles(null); return undefined; }
    window.cockpit.adoStates(proyecto, tarjeta.tipoOriginal)
      .then((s) => { if (vivo) setEstadosPosibles(s); })
      .catch(() => { if (vivo) setEstadosPosibles(null); });
    return () => { vivo = false; };
  }, [remoto, proyecto, tarjeta]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCerrar]);

  const correr = useCallback(async (fn, msg) => {
    setOcupado(true);
    try {
      const r = await fn();
      if (r) setDetalle((d) => ({ ...d, ...r }));
      if (msg) flash(msg);
      onCambio();
    } catch (e) {
      flash(String(e.message || e).replace(/^Error:\s*/, ''), true);
    } finally { setOcupado(false); }
  }, [flash, onCambio]);

  if (error) {
    return (
      <div className="visor-agente">
        <div className="visor-head">
          <b style={{ flex: 1 }}>No se pudo abrir</b>
          <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
        </div>
        <div className="empty">{error}</div>
      </div>
    );
  }

  if (!detalle) {
    return (
      <div className="visor-agente">
        <div className="visor-head">
          <b style={{ flex: 1 }}>#{idTarjeta}</b>
          <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
        </div>
        <div className="empty"><span className="spin" /></div>
      </div>
    );
  }

  const d = detalle;
  const color = NIVEL_COLOR[d.nivel] || 'var(--dim)';
  const estados = remoto
    ? (estadosPosibles || []).map((e) => e.nombre)
    : (columnas || []).map((c) => c.id);
  const estadoActual = remoto ? d.columna : d.columna;

  const cambiarEstado = (valor) => {
    if (!valor || valor === estadoActual) return;
    correr(
      () => (remoto
        ? window.cockpit.adoSetState(proyecto, d.id, valor)
        : window.cockpit.boardMoveCard(boardId, d.id, valor).then(() => ({ columna: valor }))),
      'Estado: ' + valor
    );
  };

  const asignar = (valor) => {
    // El valor es la clave (el email); para el aviso se busca el nombre.
    const quien = (responsables || []).find((r) => r.valor === valor);
    const etiqueta = (quien && quien.etiqueta) || valor;
    correr(
      () => (remoto
        ? window.cockpit.adoAssign(proyecto, d.id, valor)
        : window.cockpit.boardSaveCard(boardId, { ...d, asignado: valor || null })
          .then(() => ({ asignado: valor || null }))),
      valor ? 'Asignado a ' + etiqueta : 'Sin asignar'
    );
  };

  const comentar = () => {
    const t = comentario.trim();
    if (!t) return;
    correr(
      () => (remoto
        ? window.cockpit.adoComment(proyecto, d.id, t)
        : window.cockpit.boardComment(boardId, d.id, t)),
      'Comentario agregado'
    ).then(() => setComentario(''));
  };

  return (
    <div className="visor-agente">
      <div className="visor-head">
        <span className="chip" style={{ borderColor: color, color }}>
          {d.tipoOriginal || d.nivel}
        </span>
        <b className="trunc" style={{ flex: 1, minWidth: 0 }} title={d.titulo}>
          {remoto ? '#' + d.id + ' · ' : ''}{d.titulo}
        </b>
        {ocupado && <span className="spin" />}
        {d.url && (
          <button className="btn sm" onClick={() => window.cockpit.openExternal(d.url)}>
            Abrir en ADO
          </button>
        )}
        <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
      </div>

      <div className="thread-scroll" style={{ padding: 16 }}>
        <div className="grid g2" style={{ gap: 14, alignItems: 'start' }}>

          <div className="card">
            <h3>Estado y responsable</h3>

            <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <span className="dim" style={{ flex: '0 1 130px', fontSize: 11.5 }}>Estado</span>
              {estados.length ? (
                <select
                  value={estadoActual} disabled={ocupado}
                  onChange={(e) => cambiarEstado(e.target.value)}
                  style={{ flex: 1, fontSize: 12 }}
                >
                  {!estados.includes(estadoActual) && <option value={estadoActual}>{estadoActual}</option>}
                  {estados.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              ) : <span style={{ fontSize: 12 }}>{estadoActual}</span>}
            </div>

            <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <span className="dim" style={{ flex: '0 1 130px', fontSize: 11.5 }}>Responsable</span>
              {remoto ? (
                <select
                  value={d.asignadoClave || ''} disabled={ocupado}
                  onChange={(e) => asignar(e.target.value)}
                  style={{ flex: 1, fontSize: 12 }}
                >
                  <option value="">Sin asignar</option>
                  {/* Si el responsable actual no esta en la lista, el select
                      no encuentra su opcion y el navegador cae en la primera:
                      aparecia "Sin asignar" en tarjetas que si tenian duenio. */}
                  {d.asignadoClave && !(responsables || []).some((r) => r.valor === d.asignadoClave) && (
                    <option value={d.asignadoClave}>{d.asignado || d.asignadoClave}</option>
                  )}
                  {(responsables || []).filter((r) => r.valor !== '__sin_asignar__').map((r) => (
                    <option key={r.valor} value={r.valor}>{r.etiqueta}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text" defaultValue={d.asignado || ''} disabled={ocupado}
                  placeholder="a nombre de…"
                  onBlur={(e) => e.target.value !== (d.asignado || '') && asignar(e.target.value)}
                  style={{ flex: 1, fontSize: 12 }}
                />
              )}
            </div>

            <Campo k="Sprint" v={d.sprint} />
            <Campo k="Estimación" v={d.estimacion ? String(d.estimacion) : null} />
            <Campo k="Prioridad" v={d.prioridad != null ? String(d.prioridad) : null} />
            <Campo k="Etiquetas" v={(d.etiquetas || []).join(', ') || null} />
            <Campo k="Creado" v={d.creado ? fmtDate(d.creado, false) : null} />
            <Campo k="Modificado" v={d.modificado ? fmtAgo(d.modificado) : null} />

            {(d.relaciones || []).length > 0 && (
              <>
                <div className="dim" style={{ fontSize: 11.5, marginTop: 10, marginBottom: 4 }}>Relaciones</div>
                {d.relaciones.map((r, i) => (
                  <div key={i} className="chip alt" style={{ fontSize: 10.5, marginRight: 4 }}>
                    {r.tipo} #{r.id}
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <h3>Discusión {(d.comentarios || []).length ? `· ${d.comentarios.length}` : ''}</h3>
            <div style={{ maxHeight: 260, overflow: 'auto', marginBottom: 10 }}>
              {!(d.comentarios || []).length && (
                <div className="dim" style={{ fontSize: 12 }}>Todavía no hay comentarios.</div>
              )}
              {(d.comentarios || []).map((c) => (
                <div key={c.id} className="block" style={{ marginBottom: 8 }}>
                  <div className="dim" style={{ fontSize: 10.5, marginBottom: 3 }}>
                    {c.autor || 'alguien'} · {c.fecha ? fmtAgo(c.fecha) : ''}
                  </div>
                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.texto}</div>
                </div>
              ))}
            </div>
            <textarea
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              placeholder={remoto ? 'Escribir en la discusión del work item…' : 'Nota para vos…'}
              rows={3}
              style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
            />
            <div className="row" style={{ marginTop: 6 }}>
              {remoto && (
                <span className="dim" style={{ fontSize: 10.5, flex: 1 }}>
                  Lo va a ver todo el equipo en Azure DevOps.
                </span>
              )}
              <button
                className="btn sm primary right"
                disabled={ocupado || !comentario.trim()}
                onClick={comentar}
              >
                Comentar
              </button>
            </div>
          </div>
        </div>

        {(d.textos || []).map((t, i) => (
          <div className="card" key={i} style={{ marginTop: 14 }}>
            <h3>{t.titulo}</h3>
            <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {t.texto}
            </div>
          </div>
        ))}

        {!remoto && d.descripcion && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3>Descripción</h3>
            <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {d.descripcion}
            </div>
          </div>
        )}

        {(d.otros || []).length > 0 && (
          <details className="card" style={{ marginTop: 14 }}>
            <summary className="dim" style={{ fontSize: 11.5, cursor: 'pointer' }}>
              Otros {d.otros.length} campos del work item
            </summary>
            <div style={{ marginTop: 10 }}>
              {d.otros.map((o, i) => <Campo key={i} k={o.campo} v={o.valor} />)}
            </div>
          </details>
        )}

        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}
