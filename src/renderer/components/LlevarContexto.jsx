import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtBytes, fmtDate } from '../util.js';

// Elegir a mano qué contexto llevarte, y dejarlo en una carpeta.
//
// El catálogo de la skill es automático y completo: sirve para que una sesión
// pregunte "qué hay". Esto es lo contrario — vos tildás, y sale algo que se
// copia a un pendrive o se importa en otra sesión.
//
// Las cuatro cosas no pesan igual y esa es la decisión que hay que hacer
// visible: una memoria son 2 KB, un transcript puede ser 5 MB y un grafo 18 MB.
// Por eso el peso proyectado se muestra arriba y cambia mientras tildás, en vez
// de enterarte después de exportar.

// Un resumen de conversación ronda esto. No es exacto — depende de cuánto
// hablaste — pero sirve para que el número de arriba no mienta por órdenes de
// magnitud cuando el paquete es liviano.
const KB_RESUMEN = 10 * 1024;

function Check({ marcado, onChange, children, sangria = 0, peso = null, aviso = null }) {
  return (
    <label
      className="row"
      style={{
        gap: 7, alignItems: 'flex-start', padding: '3px 0 3px ' + (10 + sangria * 18) + 'px',
        cursor: 'pointer', fontSize: 12, lineHeight: 1.5,
      }}
    >
      <input
        type="checkbox"
        checked={marcado}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flex: '0 0 auto' }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        {children}
        {aviso && <span style={{ color: 'var(--yellow)', marginLeft: 6 }}>{aviso}</span>}
      </span>
      {peso != null && (
        <span className="dim" style={{ fontSize: 10.5, flex: '0 0 auto', marginTop: 1 }}>
          {fmtBytes(peso)}
        </span>
      )}
    </label>
  );
}

export default function LlevarContexto({ onCerrar, flash }) {
  const [inv, setInv] = useState(null);
  const [sel, setSel] = useState({ memorias: [], claudeMd: [], sesiones: [], grafos: [] });
  const [autocontenido, setAutocontenido] = useState(false);
  const [abierto, setAbierto] = useState({});
  const [busy, setBusy] = useState(false);
  const [hecho, setHecho] = useState(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    window.cockpit.ctxInventory()
      .then(setInv)
      .catch((e) => { flash(String(e.message || e), true); setInv({ proyectos: [], grafos: [] }); });
  }, [flash]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCerrar]);

  const alternar = useCallback((clave, id, marcado) => {
    setSel((s) => ({
      ...s,
      [clave]: marcado ? [...new Set([...s[clave], id])] : s[clave].filter((x) => x !== id),
    }));
  }, []);

  const tiene = useCallback((clave, id) => sel[clave].includes(id), [sel]);

  // Todo lo de un proyecto de una: es lo que más se usa y tildar de a uno en
  // un proyecto con 6 memorias y 20 sesiones es tedioso.
  const todoDelProyecto = useCallback((p, marcado) => {
    setSel((s) => {
      const mem = p.memorias.map((m) => m.id);
      const ses = p.sesiones.map((x) => x.sessionId);
      const md = p.claudeMd ? [p.claudeMd.id] : [];
      const unir = (prev, ids) => (marcado
        ? [...new Set([...prev, ...ids])]
        : prev.filter((x) => !ids.includes(x)));
      return {
        ...s,
        memorias: unir(s.memorias, mem),
        claudeMd: unir(s.claudeMd, md),
        sesiones: unir(s.sesiones, ses),
      };
    });
  }, []);

  const peso = useMemo(() => {
    if (!inv) return 0;
    let total = 0;
    for (const p of inv.proyectos) {
      for (const m of p.memorias) if (sel.memorias.includes(m.id)) total += m.bytes || 0;
      if (p.claudeMd && sel.claudeMd.includes(p.claudeMd.id)) total += p.claudeMd.bytes || 0;
      for (const s of p.sesiones) {
        if (!sel.sesiones.includes(s.sessionId)) continue;
        total += autocontenido ? (s.bytes || 0) + KB_RESUMEN : KB_RESUMEN;
      }
    }
    for (const g of inv.grafos) {
      if (sel.grafos.includes(g.id) && autocontenido) total += g.bytes || 0;
    }
    return total;
  }, [inv, sel, autocontenido]);

  const cuenta = sel.memorias.length + sel.claudeMd.length + sel.sesiones.length + sel.grafos.length;

  const exportar = async () => {
    setBusy(true);
    try {
      const destino = await window.cockpit.ctxPickDir();
      if (!destino) return;
      const r = await window.cockpit.ctxExport(sel, { destino, autocontenido });
      setHecho(r);
      flash('Carpeta lista');
    } catch (e) {
      flash(String(e.message || e).replace(/^Error:\s*/, ''), true);
    } finally { setBusy(false); }
  };

  const marco = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
  };

  if (hecho) {
    const comando = '/cockpit-memory importar ' + hecho.dir;
    const r = hecho.resumen;
    return (
      <div style={marco}>
        <div className="card" style={{ width: 660, maxWidth: '95vw' }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <b style={{ fontSize: 14, flex: 1 }}>Carpeta lista</b>
            <button className="btn sm" onClick={onCerrar}>Cerrar</button>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            {r.memorias} memorias, {r.claudeMd} CLAUDE.md, {r.conversaciones} conversaciones
            {r.grafos > 0 && <> y {r.grafos} grafos{r.grafosCopiados > 0 ? ` (${r.grafosCopiados} copiados enteros)` : ' (solo el puntero)'}</>}
            {', '}de {r.proyectos} {r.proyectos === 1 ? 'proyecto' : 'proyectos'} · {fmtBytes(hecho.bytes)}
          </div>
          <div
            className="dim"
            style={{
              fontSize: 11, marginTop: 10, background: 'var(--panel-2)', border: '1px solid var(--line)',
              borderRadius: 7, padding: '7px 10px', overflowWrap: 'anywhere',
            }}
          >
            {hecho.dir}
          </div>
          <div style={{ fontSize: 12, marginTop: 14 }}>Para traerlo en cualquier sesión de Claude Code:</div>
          <div
            className="row"
            style={{
              gap: 8, background: 'var(--panel-2)', border: '1px solid var(--line)',
              borderRadius: 7, padding: '7px 10px', marginTop: 5,
            }}
          >
            <code style={{ flex: 1, minWidth: 0, fontSize: 11.5, overflowWrap: 'anywhere' }}>{comando}</code>
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(comando);
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 1600);
                } catch { /* sin portapapeles */ }
              }}
            >
              {copiado ? 'copiado' : 'copiar'}
            </button>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <button
              className="btn sm primary"
              onClick={() => window.cockpit.ctxReveal(hecho.dir).catch((e) => flash(String(e.message || e), true))}
            >
              Abrir la carpeta
            </button>
            <button className="btn sm" onClick={() => { setHecho(null); setCopiado(false); }}>
              Armar otro
            </button>
          </div>
          <div className="dim" style={{ fontSize: 10.5, marginTop: 12, lineHeight: 1.6 }}>
            Adentro hay un <code>LEEME.md</code> que explica qué tiene y cómo se importa, para
            cuando lo abras dentro de tres semanas. Si lo vas a mover a otra máquina, clic
            derecho → Enviar a → Carpeta comprimida.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={marco}>
      <div className="card" style={{ width: 760, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <b style={{ fontSize: 14, flex: 1 }}>Llevarte contexto</b>
          <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
        </div>
        <div className="dim" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.6 }}>
          Elegí qué querés llevarte. Sale una carpeta con las memorias, los CLAUDE.md y un
          resumen de cada conversación, más un <code>manifest.json</code> que le dice a Claude
          dónde va cada cosa.
        </div>

        <label
          className="row"
          style={{
            gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12,
            background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 7,
            padding: '9px 11px', marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={autocontenido}
            onChange={(e) => setAutocontenido(e.target.checked)}
            style={{ marginTop: 2, flex: '0 0 auto' }}
          />
          <span>
            <b>Carpeta autocontenida</b> — para otra máquina
            <div className="dim" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.55 }}>
              Copia adentro los transcripts completos y los grafos que elijas. Sin esto el
              paquete lleva solo resúmenes y punteros, que alcanza si lo vas a importar en
              esta misma máquina, donde los originales siguen estando.
            </div>
          </span>
        </label>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: '0 -4px' }}>
          {!inv && <div className="card dim">Revisando qué hay…</div>}

          {inv && !inv.proyectos.length && !inv.grafos.length && (
            <div className="card dim" style={{ fontSize: 12 }}>
              No hay nada guardado todavía: ni memorias, ni CLAUDE.md, ni conversaciones.
            </div>
          )}

          {inv && inv.proyectos.map((p) => {
            const total = p.memorias.length + (p.claudeMd ? 1 : 0) + p.sesiones.length;
            const elegidos = p.memorias.filter((m) => tiene('memorias', m.id)).length
              + (p.claudeMd && tiene('claudeMd', p.claudeMd.id) ? 1 : 0)
              + p.sesiones.filter((s) => tiene('sesiones', s.sessionId)).length;
            const desplegado = abierto[p.projectDir];
            return (
              <div key={p.projectDir} className="card" style={{ marginBottom: 8, padding: '9px 10px' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={elegidos > 0 && elegidos === total}
                    ref={(el) => { if (el) el.indeterminate = elegidos > 0 && elegidos < total; }}
                    onChange={(e) => todoDelProyecto(p, e.target.checked)}
                    style={{ flex: '0 0 auto' }}
                  />
                  <button
                    className="btn sm"
                    onClick={() => setAbierto((a) => ({ ...a, [p.projectDir]: !a[p.projectDir] }))}
                    style={{ flex: 1, textAlign: 'left', justifyContent: 'flex-start', background: 'none', border: 'none', padding: 0 }}
                  >
                    <b style={{ fontSize: 12.5 }}>{p.nombre}</b>
                    <span className="dim" style={{ fontSize: 11, marginLeft: 8 }}>
                      {p.memorias.length} memorias · {p.sesiones.length} conversaciones
                      {p.claudeMd ? ' · CLAUDE.md' : ''}
                    </span>
                  </button>
                  {elegidos > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--accent)' }}>{elegidos} elegidos</span>
                  )}
                  <span className="dim" style={{ fontSize: 11 }}>{desplegado ? '▾' : '▸'}</span>
                </div>

                {desplegado && (
                  <div style={{ marginTop: 6, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                    {p.memorias.map((m) => (
                      <Check
                        key={m.id}
                        marcado={tiene('memorias', m.id)}
                        onChange={(v) => alternar('memorias', m.id, v)}
                        peso={m.bytes}
                      >
                        <b>{m.nombre}</b>
                        <span className="dim"> · {m.tipo}</span>
                        {m.descripcion && (
                          <div className="dim" style={{ fontSize: 11, lineHeight: 1.45 }}>{m.descripcion}</div>
                        )}
                      </Check>
                    ))}

                    {p.claudeMd && (
                      <Check
                        marcado={tiene('claudeMd', p.claudeMd.id)}
                        onChange={(v) => alternar('claudeMd', p.claudeMd.id, v)}
                        peso={p.claudeMd.bytes}
                      >
                        <b>CLAUDE.md</b>
                        <span className="dim"> · instrucciones del repo</span>
                      </Check>
                    )}

                    {p.sesiones.map((s) => (
                      <Check
                        key={s.sessionId}
                        marcado={tiene('sesiones', s.sessionId)}
                        onChange={(v) => alternar('sesiones', s.sessionId, v)}
                        peso={autocontenido ? s.bytes : KB_RESUMEN}
                      >
                        {String(s.titulo).slice(0, 90)}
                        <div className="dim" style={{ fontSize: 11 }}>
                          {s.desde ? fmtDate(s.desde) : 'sin fecha'} · {s.turnos} turnos tuyos
                          {s.rama ? ' · ' + s.rama : ''}
                        </div>
                      </Check>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {inv && inv.grafos.length > 0 && (
            <div className="card" style={{ marginBottom: 8, padding: '9px 10px' }}>
              <b style={{ fontSize: 12.5 }}>Grafos de código</b>
              <div className="dim" style={{ fontSize: 11, marginTop: 3, marginBottom: 4, lineHeight: 1.55 }}>
                Sin el paquete autocontenido viaja solo el puntero — qué repo, qué commit y con
                qué herramientas se consulta. Casi siempre conviene así: reindexar del otro lado
                tarda minutos y te da el código de hoy, no el de cuando indexaste.
              </div>
              {inv.grafos.map((g) => (
                <Check
                  key={g.id}
                  marcado={tiene('grafos', g.id)}
                  onChange={(v) => alternar('grafos', g.id, v)}
                  peso={autocontenido ? g.bytes : null}
                  aviso={g.desactualizado ? '⚠ índice desactualizado' : null}
                >
                  <b>{g.nombre}</b>
                  <span className="dim"> · {g.proveedor}</span>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {g.nodos ? g.nodos.toLocaleString('es-AR') + ' nodos' : 'sin datos'}
                    {g.commitIndexado ? ' · commit ' + String(g.commitIndexado).slice(0, 7) : ''}
                  </div>
                </Check>
              ))}
            </div>
          )}
        </div>

        <div
          className="row"
          style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', alignItems: 'center' }}
        >
          <div style={{ flex: 1, fontSize: 12 }}>
            {cuenta === 0
              ? <span className="dim">No elegiste nada todavía.</span>
              : <>{cuenta} {cuenta === 1 ? 'cosa elegida' : 'cosas elegidas'} · <b>{fmtBytes(peso)}</b> aprox.</>}
          </div>
          {busy && <span className="spin" />}
          <button className="btn primary" onClick={exportar} disabled={busy || cuenta === 0}>
            Elegir carpeta y armar
          </button>
        </div>
      </div>
    </div>
  );
}
