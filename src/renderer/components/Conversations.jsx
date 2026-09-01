import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fmtInt, fmtTokens, fmtUSD, fmtDate, fmtAgo, fmtDuration, fmtBytes, basename,
} from '../util.js';
import { esOutcome, esHelpfulness, esSessionType, esFriction } from '../i18n.js';
import { useMoney } from '../money.js';

const OUTCOME_CHIP = {
  achieved: 'on', mostly_achieved: 'on',
  partially_achieved: 'warn', not_achieved: 'bad',
};

// Qué se muestra del hilo. "Conversación" deja solo lo que se dijeron; el resto
// (herramientas, resultados, adjuntos del harness) es maquinaria.
const VISTAS = [
  { id: 'charla', label: 'Conversación', hint: 'Solo lo que escribiste vos y lo que te contestó Claude' },
  { id: 'todo', label: 'Todo', hint: 'Incluye herramientas, resultados y adjuntos internos' },
];

// Cuantos mensajes se dibujan de una. Un hilo largo con todo montado congela
// la ventana, asi que se muestran los ultimos y el resto se pide a mano.
const PAGINA = 150;

// La miniatura viaja con el hilo; la imagen completa se pide al hacer clic.
// Asi abrir una conversacion con 95 capturas cuesta 5 MB en vez de 26.
function Imagen({ b, pedirImagen }) {
  const [full, setFull] = useState(null);
  const [cargando, setCargando] = useState(false);

  if (b.vacia) return <div className="block dim" style={{ fontStyle: 'italic' }}>[Imagen sin datos]</div>;

  const src = full || b.thumb || b.dataUri || b.url;
  if (!src) {
    return (
      <div className="block dim" style={{ fontStyle: 'italic' }}>
        [Imagen {b.media} · {fmtBytes(b.bytes)}{b.tooBig ? ' — demasiado grande para mostrarla' : ''}]
      </div>
    );
  }

  const pedirCompleta = async () => {
    if (full || !b.ref || !pedirImagen) return;
    setCargando(true);
    try {
      const r = await pedirImagen(b.ref);
      if (r && r.dataUri) setFull(r.dataUri);
    } catch { /* se queda con la miniatura */ }
    finally { setCargando(false); }
  };

  return (
    <div style={{ marginBottom: 6 }}>
      <img
        src={src}
        alt="imagen del mensaje"
        onClick={() => (full ? setFull(null) : pedirCompleta())}
        style={{
          maxWidth: full ? '100%' : 320,
          maxHeight: full ? 'none' : 200,
          borderRadius: 8,
          border: '1px solid var(--line)',
          cursor: full ? 'zoom-out' : 'zoom-in',
          display: 'block',
        }}
      />
      <div className="dim" style={{ fontSize: 10.5, marginTop: 3 }}>
        {b.media} · {fmtBytes(b.bytes)}
        {cargando ? ' · cargando…'
          : full ? ' · clic para achicar'
          : (b.completaDisponible ? ' · miniatura, clic para ver completa' : ' · clic para agrandar')}
      </div>
    </div>
  );
}

function Block({ b, pedirImagen }) {
  if (b.type === 'image') return <Imagen b={b} pedirImagen={pedirImagen} />;

  if (b.type === 'tool_use') {
    return (
      <details className="block tool_use">
        <summary className="block-label">herramienta · <b>{b.name}</b></summary>
        <pre style={{ marginTop: 8 }}>{b.text}</pre>
        {b.truncated > 0 && <div className="truncnote">+{fmtInt(b.truncated)} caracteres recortados</div>}
      </details>
    );
  }
  if (b.type === 'tool_result') {
    return (
      <details className={'block tool_result' + (b.isError ? ' err' : '')}>
        <summary className="block-label">
          resultado{b.isError ? ' · error' : ''} · {fmtInt(b.text.length + b.truncated)} caracteres
        </summary>
        <pre style={{ marginTop: 8 }}>{b.text}</pre>
        {b.truncated > 0 && <div className="truncnote">+{fmtInt(b.truncated)} caracteres recortados</div>}
      </details>
    );
  }
  if (b.type === 'thinking') {
    return (
      <details className="block thinking">
        <summary className="block-label">razonamiento</summary>
        <div style={{ marginTop: 8 }}>{b.text}</div>
      </details>
    );
  }
  return <TextBlock b={b} />;
}

// Un bloque de texto largo se muestra recortado con un boton para expandirlo:
// un SKILL.md entero adentro de una burbuja hace scrollear media hora.
const LARGO = 1800;

function TextBlock({ b }) {
  const [abierto, setAbierto] = useState(false);
  const texto = b.text || '';
  const esLargo = texto.length > LARGO;
  const visible = esLargo && !abierto ? texto.slice(0, LARGO) : texto;

  return (
    <div className={'block' + (esLargo && !abierto ? ' clamped' : '')}>
      {visible}
      {esLargo && !abierto && '…'}
      {b.truncated > 0 && abierto && (
        <div className="truncnote">+{fmtInt(b.truncated)} caracteres recortados</div>
      )}
      {esLargo && (
        <button className="btn sm expand" onClick={() => setAbierto((v) => !v)}>
          {abierto
            ? 'Achicar'
            : `Mostrar todo · ${fmtInt(texto.length + (b.truncated || 0))} caracteres`}
        </button>
      )}
    </div>
  );
}

const INYECTADO = {
  skill: 'contenido de una skill que se cargó',
  comando: 'comando que ejecutaste (/algo)',
  resumen: 'resumen de la sesión anterior',
  harness: 'texto que insertó Claude Code',
};

function Message({ m, vista, money, pedirImagen }) {
  const soloCharla = vista === 'charla';

  // Turnos que figuran como tuyos pero los escribió el harness (el SKILL.md
  // entero al cargar una skill, por ejemplo). Van colapsados: ocupan miles de
  // caracteres y casi nunca los querés leer, pero ocultarlos seria mentir
  // sobre lo que el modelo recibio.
  if (m.injected) {
    const chars = m.blocks.reduce((a, b) => a + ((b.text || '').length + (b.truncated || 0)), 0);
    return (
      <details className="msg inyectado">
        <summary className="msg-head">
          <span className="msg-role role-inject">inyectado</span>
          <span className="dim">{INYECTADO[m.injectedKind] || INYECTADO.harness}</span>
          <span className="dim">· {fmtInt(chars)} caracteres</span>
          <span className="dim right">{fmtDate(m.ts)}</span>
        </summary>
        <div style={{ marginTop: 6 }}>
          {m.blocks.map((b, i) => <Block key={i} b={b} pedirImagen={pedirImagen} />)}
        </div>
      </details>
    );
  }

  if (m.role === 'system') {
    if (soloCharla) return null;
    const preview = ((m.blocks[0] && m.blocks[0].text) || '').replace(/\s+/g, ' ').slice(0, 120);
    return (
      <details className="msg">
        <summary className="msg-head">
          <span className="msg-role role-system">{m.label || 'sistema'}</span>
          <span className="dim trunc" style={{ flex: 1 }}>{preview}</span>
          <span className="dim">{fmtDate(m.ts)}</span>
        </summary>
        {m.blocks.map((b, i) => <Block key={i} b={b} pedirImagen={pedirImagen} />)}
      </details>
    );
  }

  if (soloCharla && m.isToolReturn) return null;

  const blocks = soloCharla
    ? m.blocks.filter((b) => b.type === 'text' || b.type === 'image')
    : m.blocks;
  if (!blocks.length) return null;

  const roleLabel = m.role === 'user' ? (m.isToolReturn ? 'resultado' : 'vos') : 'claude';

  return (
    <div className="msg" style={m.isSidechain ? { marginLeft: 24, opacity: 0.92 } : null}>
      <div className="msg-head">
        <span className={'msg-role role-' + m.role}>{roleLabel}</span>
        {m.isSidechain && <span className="chip alt" style={{ fontSize: 10 }}>subagente</span>}
        {!soloCharla && m.model && <span className="dim">{m.model}</span>}
        {!soloCharla && m.effort && <span className="dim">effort {m.effort}</span>}
        <span className="dim">{fmtDate(m.ts)}</span>
        {m.usage && !soloCharla && (
          <span className="dim right num" title="salida · caché leída · costo equivalente">
            {fmtTokens(m.usage.output)} out · {fmtTokens(m.usage.cacheRead)} caché
            {money.show ? ' · ' + fmtUSD(m.usage.costUSD) : ''}
          </span>
        )}
      </div>
      {blocks.map((b, i) => <Block key={i} b={b} pedirImagen={pedirImagen} />)}
    </div>
  );
}

// Un transcript de subagente es un archivo aparte: no tiene sessionId, se
// identifica por su ruta. Se abre en una capa encima del hilo principal para
// no perder el lugar donde estabas leyendo.
function VisorAgente({ agente, onCerrar, vista, money }) {
  const [hilo, setHilo] = useState(null);
  const [error, setError] = useState(null);

  // loadThread devuelve el arreglo de mensajes pelado, no un objeto: el
  // recorte lo hace el visor, igual que el hilo principal.
  const [limite, setLimite] = useState(PAGINA);

  useEffect(() => {
    let vivo = true;
    setHilo(null); setError(null); setLimite(PAGINA);
    window.cockpit.agentThread(agente.file, {})
      .then((h) => { if (vivo) setHilo(Array.isArray(h) ? h : []); })
      .catch((e) => { if (vivo) setError(String(e.message || e).replace(/^Error:\s*/, '')); });
    return () => { vivo = false; };
  }, [agente.file]);

  const pedirImagen = useCallback(
    (ref) => window.cockpit.agentImage(agente.file, ref),
    [agente.file]
  );

  const visibles = hilo || [];
  const dibujados = visibles.slice(Math.max(0, visibles.length - limite));
  const ocultos = visibles.length - dibujados.length;

  // Escape cierra, que es lo que uno espera de una capa.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCerrar]);

  return (
    <div className="visor-agente">
      <div className="visor-head">
        <span className="chip">{agente.workflowId ? 'workflow' : 'subagente'}</span>
        <b className="trunc" style={{ flex: 1, minWidth: 0 }} title={agente.title}>{agente.title}</b>
        <span className="dim num">
          {agente.totals.requests} requests · {money.show
            ? fmtUSD(agente.totals.costUSD)
            : fmtTokens(agente.totals.totalTokens)}
        </span>
        <button className="btn sm" onClick={() => window.cockpit.revealPath(agente.file)}>Ver archivo</button>
        <button className="btn sm" onClick={onCerrar}>Cerrar (Esc)</button>
      </div>
      <div className="thread-scroll">
        {error && <div className="empty">{error}</div>}
        {!hilo && !error && <div className="empty"><span className="spin" /></div>}
        {hilo && !hilo.length && <div className="empty">Este transcript no tiene mensajes.</div>}
        {hilo && ocultos > 0 && (
          <div className="row" style={{ justifyContent: 'center', marginBottom: 14 }}>
            <button className="btn sm" onClick={() => setLimite((v) => v + PAGINA)}>
              Cargar {Math.min(PAGINA, ocultos)} {ocultos === 1 ? 'mensaje' : 'mensajes'} anteriores
            ({fmtInt(ocultos)} sin mostrar)
            </button>
          </div>
        )}
        {dibujados.map((m) => (
          <Message key={m.i} m={m} vista={vista} money={money} pedirImagen={pedirImagen} />
        ))}
      </div>
    </div>
  );
}

export default function Conversations({ snap, flash }) {
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [project, setProject] = useState('');
  const [machineId, setMachineId] = useState('');
  const [showAgents, setShowAgents] = useState(false);
  const [vista, setVista] = useState('charla');
  const [archived, setArchived] = useState([]);
  const [verArchivadas, setVerArchivadas] = useState(false);
  const [agente, setAgente] = useState(null);
  const scrollRef = useRef(null);
  const machines = snap.machines || [];
  const money = useMoney();

  useEffect(() => {
    window.cockpit.getArchived().then(setArchived).catch(() => setArchived([]));
  }, []);

  const archivedSet = useMemo(() => new Set(archived), [archived]);

  // El visor es una capa dentro del panel del hilo, pero la lista de la
  // izquierda sigue clickeable: sin esto, cambiabas de sesion y seguias
  // mirando el transcript de un subagente que ya no le pertenece.
  useEffect(() => { setAgente(null); }, [selected]);
  // Estable, para que el efecto de Escape del visor no se resuscriba en cada
  // render del padre.
  const cerrarAgente = useCallback(() => setAgente(null), []);

  // `selected` es el id de la sesion (un string), pero la imagen se pide con
  // el id del hilo efectivamente cargado, que es el que el main resuelve a un
  // archivo. Coinciden salvo cuando se llego desde un resultado de busqueda.
  const sesionAbierta = (thread && thread.session && thread.session.sessionId) || selected;
  const pedirImagenSesion = useCallback(
    (ref) => window.cockpit.threadImage(sesionAbierta, ref),
    [sesionAbierta]
  );

  const enFiltro = useMemo(() => {
    let list = snap.sessions;
    if (project) list = list.filter((s) => s.projectKey === project);
    if (machineId) list = list.filter((s) => s.machineId === machineId);
    return list;
  }, [snap.sessions, project, machineId]);

  const sessions = useMemo(
    () => enFiltro.filter((s) => (verArchivadas ? archivedSet.has(s.sessionId) : !archivedSet.has(s.sessionId))),
    [enFiltro, verArchivadas, archivedSet]
  );

  const archivadasEnVista = useMemo(
    () => enFiltro.filter((s) => archivedSet.has(s.sessionId)).length,
    [enFiltro, archivedSet]
  );

  const toggleArchivo = useCallback(async (e, sessionId) => {
    if (e) e.stopPropagation();
    try {
      setArchived(await window.cockpit.toggleArchived(sessionId));
    } catch (err) {
      flash('No se pudo archivar: ' + err.message, true);
    }
  }, [flash]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    window.cockpit
      .session(selected, { includeSidechain: showAgents })
      .then((d) => {
        setThread(d);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      })
      .catch((e) => flash('No se pudo abrir la sesión: ' + e.message, true))
      .finally(() => setLoading(false));
  }, [selected, showAgents, flash]);

  const runSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      setSearchResults(await window.cockpit.search(query, {
        project: project || undefined,
        includeAgents: showAgents,
        limit: 150,
      }));
    } catch (err) {
      flash('Error en la búsqueda: ' + err.message, true);
    } finally {
      setSearching(false);
    }
  };

  const visibles = useMemo(() => (thread
    ? thread.messages.filter((m) => (vista === 'charla' ? m.isConversation : true))
    : []), [thread, vista]);

  // Un hilo largo tiene miles de mensajes; dibujarlos todos de golpe traba la
  // ventana. Se muestran los ultimos y se van agregando hacia atras.
  const [limite, setLimite] = useState(PAGINA);
  useEffect(() => { setLimite(PAGINA); }, [thread, vista]);
  const dibujados = visibles.length > limite ? visibles.slice(visibles.length - limite) : visibles;
  const ocultos = visibles.length - dibujados.length;

  return (
    <div className="split">
      <div className="list-pane">
        <div className="list-head">
          <form onSubmit={runSearch} className="row" style={{ gap: 6 }}>
            <input
              type="search"
              placeholder="Buscar en todos los transcripts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn sm primary" type="submit" disabled={searching}>
              {searching ? '…' : 'Buscar'}
            </button>
            {searchResults && (
              <button className="btn sm" type="button" onClick={() => { setQuery(''); setSearchResults(null); }}>✕</button>
            )}
          </form>

          <div className="row" style={{ gap: 6 }}>
            <select value={project} onChange={(e) => setProject(e.target.value)} style={{ flex: 1, fontSize: 11.5 }}>
              <option value="">Todos los proyectos</option>
              {snap.byProject.map((p) => (
                <option key={p.key} value={p.key}>{basename(p.project)} ({p.sessions})</option>
              ))}
            </select>
            {machines.length > 1 && (
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)} style={{ fontSize: 11.5 }}>
                <option value="">Todas las máquinas</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
          </div>

          <div className="row" style={{ gap: 6 }}>
            <label className="chip" style={{ cursor: 'pointer' }} title="Incluir transcripts de subagentes y de workflows">
              <input type="checkbox" checked={showAgents} onChange={(e) => setShowAgents(e.target.checked)} style={{ margin: 0 }} />
              agentes
            </label>
            <button
              className={'btn sm' + (verArchivadas ? ' primary' : '')}
              onClick={() => setVerArchivadas((v) => !v)}
              disabled={!verArchivadas && !archivadasEnVista}
              title="Las archivadas salen de la lista para que veas solo lo que te importa"
            >
              {verArchivadas ? 'Ver activas' : `Archivadas (${archivadasEnVista})`}
            </button>
            <span className="right dim" style={{ fontSize: 11 }}>{sessions.length}</span>
          </div>
        </div>

        <div className="list-scroll">
          {searchResults ? (
            <>
              <div className="dim" style={{ padding: '8px 12px', fontSize: 11 }}>
                {searchResults.hits.length} coincidencias en {searchResults.scanned} transcripts
                {searchResults.truncated && ' (cortado por límite)'}
              </div>
              {searchResults.hits.map((h, i) => (
                <div key={i} className="hit" onClick={() => setSelected(h.parentSessionId || h.sessionId)}>
                  <div className="row" style={{ gap: 6, marginBottom: 3 }}>
                    <span className={'msg-role role-' + h.role} style={{ fontSize: 9 }}>
                      {h.role === 'user' ? 'vos' : 'claude'}
                    </span>
                    {h.kind !== 'session' && <span className="chip alt" style={{ fontSize: 10 }}>agente</span>}
                    <span className="dim" style={{ fontSize: 10.5 }}>{fmtDate(h.ts)}</span>
                  </div>
                  <div className="dim trunc" style={{ fontSize: 11, marginBottom: 3 }}>{h.title}</div>
                  <div style={{ fontSize: 12 }}>{h.snippet}</div>
                </div>
              ))}
              {!searchResults.hits.length && <div className="empty">Sin resultados</div>}
            </>
          ) : !sessions.length ? (
            <div className="empty">
              {verArchivadas ? 'No archivaste ninguna todavía.' : 'No hay conversaciones con estos filtros.'}
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.machineId + s.sessionId}
                className={'sess' + (selected === s.sessionId ? ' active' : '')}
                onClick={() => setSelected(s.sessionId)}
              >
                <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <div className="t trunc" style={{ flex: 1 }} title={s.title}>{s.title}</div>
                  <button
                    className="btn sm arch"
                    title={archivedSet.has(s.sessionId) ? 'Sacar del archivo' : 'Archivar: la saca de la lista'}
                    onClick={(e) => toggleArchivo(e, s.sessionId)}
                  >
                    {archivedSet.has(s.sessionId) ? '↩' : '⤓'}
                  </button>
                </div>
                <div className="m">
                  {s.isRemote && <span className="chip info" style={{ fontSize: 10 }}>{s.machineLabel}</span>}
                  <span>{basename(s.cwd)}</span>
                  <span>·</span>
                  <span>{fmtAgo(s.endedAt)}</span>
                  <span>·</span>
                  <span>{s.userTurns} prompts</span>
                  <span>·</span>
                  <span>{money.valor(s.totals.costUSD, s.totals.totalTokens)}</span>
                </div>
                {s.facets && (
                  <div className="row wrap" style={{ gap: 4, marginTop: 5 }}>
                    <span
                      className={'chip ' + (OUTCOME_CHIP[s.facets.outcome] || '')}
                      style={{ fontSize: 10 }}
                      title="Cómo terminó la sesión, según el análisis que hace Claude Code al cerrarla"
                    >
                      {esOutcome(s.facets.outcome)}
                    </span>
                    {s.agents && s.agents.count > 0 && (
                      <span className="chip alt" style={{ fontSize: 10 }}>{s.agents.count} agentes</span>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="thread-pane">
        {!thread ? (
          <div className="empty">
            {loading ? <><span className="spin" /> cargando…</> : 'Elegí una conversación de la izquierda.'}
          </div>
        ) : (
          <>
            <div className="thread-head">
              <div className="row" style={{ marginBottom: 8 }}>
                <b style={{ fontSize: 14, flex: 1 }} className="trunc" title={thread.session.title}>
                  {thread.session.title}
                </b>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={(e) => toggleArchivo(e, thread.session.sessionId)}>
                    {archivedSet.has(thread.session.sessionId) ? 'Desarchivar' : 'Archivar'}
                  </button>
                  {thread.session.isRemote ? (
                    <span className="chip info">{thread.session.machineLabel}</span>
                  ) : (
                    <>
                      <button className="btn sm" onClick={() => window.cockpit.revealPath(thread.session.file)}>
                        Ver archivo
                      </button>
                      <button className="btn sm" onClick={() => window.cockpit.openPath(thread.session.cwd)}>
                        Abrir proyecto
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="row wrap" style={{ gap: 5, fontSize: 11, marginBottom: 8 }}>
                <span className="chip">{basename(thread.session.cwd)}</span>
                {thread.session.gitBranch && <span className="chip info">{thread.session.gitBranch}</span>}
                <span className="chip">{thread.session.userTurns} prompts</span>
                <span className="chip">{fmtInt(thread.session.totals.requests)} requests</span>
                <span className="chip">{fmtTokens(thread.session.totals.totalTokens)} tokens</span>
                {money.show && (
                  <span className="chip warn" title="Estimado a tarifa API pública, no es una factura">
                    {fmtUSD(thread.session.totals.costUSD)} aprox.
                  </span>
                )}
                {thread.session.meta && <span className="chip">{fmtDuration(thread.session.meta.durationMinutes)}</span>}
                {thread.session.meta && thread.session.meta.filesModified > 0 && (
                  <span className="chip on">
                    +{thread.session.meta.linesAdded}/−{thread.session.meta.linesRemoved} en {thread.session.meta.filesModified} archivos
                  </span>
                )}
              </div>

              <div className="row" style={{ gap: 6 }}>
                {VISTAS.map((v) => (
                  <button
                    key={v.id}
                    className={'btn sm' + (vista === v.id ? ' primary' : '')}
                    title={v.hint}
                    onClick={() => setVista(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
                <span className="dim" style={{ fontSize: 11 }}>
                  {ocultos > 0 ? `${dibujados.length} de ` : ''}{visibles.length}
                  {' de '}{thread.messages.length} mensajes
                </span>

                {thread.session.facets && (
                  <details className="right analisis">
                    <summary
                      className="chip info"
                      title="Resumen que genera Claude Code al terminar: qué buscabas, si lo lograste y qué se trabó"
                    >
                      análisis
                    </summary>
                    <div className="card analisis-pop">
                      <div style={{ marginBottom: 8 }}>
                        <span className="dim">Objetivo real: </span>
                        {thread.session.facets.underlyingGoal}
                      </div>
                      <div className="row wrap" style={{ gap: 5 }}>
                        <span className={'chip ' + (OUTCOME_CHIP[thread.session.facets.outcome] || '')}>
                          {esOutcome(thread.session.facets.outcome)}
                        </span>
                        <span className="chip">{esHelpfulness(thread.session.facets.helpfulness)}</span>
                        <span className="chip">{esSessionType(thread.session.facets.sessionType)}</span>
                        {Object.entries(thread.session.facets.friction || {}).map(([k, v]) => (
                          <span key={k} className="chip warn">{esFriction(k)}: {v}</span>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
              </div>

              {thread.agents.length > 0 && vista === 'todo' && (
                <details style={{ marginTop: 8 }}>
                  <summary className="chip alt">
                    {thread.agents.length} transcripts de agentes
                    {money.show ? ' · ' + fmtUSD(thread.session.agents.totals.costUSD) : ''}
                  </summary>
                  <div className="card" style={{ marginTop: 8, maxHeight: 190, overflow: 'auto' }}>
                    <table>
                      <thead>
                        <tr><th>Agente</th><th>Tipo</th><th className="n">Requests</th><th className="n">{money.show ? 'Equiv.' : 'Tokens'}</th></tr>
                      </thead>
                      <tbody>
                        {thread.agents.map((a) => (
                          <tr key={a.file} className="clickable" onClick={() => setAgente(a)}
                            title="Abrir el transcript de este agente">
                            <td className="trunc" style={{ maxWidth: 280 }}>{a.title}</td>
                            <td><span className="chip" style={{ fontSize: 10 }}>{a.workflowId ? 'workflow' : 'subagente'}</span></td>
                            <td className="n">{a.totals.requests}</td>
                            <td className="n">{money.show ? fmtUSD(a.totals.costUSD) : fmtTokens(a.totals.totalTokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>

            <div className="thread-scroll" ref={scrollRef}>
              {loading && <div className="empty"><span className="spin" /></div>}
              {thread.remoteOnly ? (
                <div className="empty" style={{ maxWidth: 480, margin: '40px auto' }}>
                  Esta sesión ocurrió en <b>{thread.session.machineLabel}</b>.
                  <div className="dim" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
                    Los números viajan en el digest, pero el transcript se quedó en esa máquina:
                    el contenido de las conversaciones nunca se sincroniza. Abrí la app allá para leerla.
                  </div>
                </div>
              ) : !visibles.length ? (
                <div className="empty">
                  Esta sesión no tiene mensajes de conversación.
                  <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>Probá con la vista "Todo".</div>
                </div>
              ) : (
                <>
                  {ocultos > 0 && (
                    <div className="row" style={{ justifyContent: 'center', marginBottom: 14 }}>
                      <button className="btn sm" onClick={() => setLimite((v) => v + PAGINA)}>
                        Cargar {Math.min(PAGINA, ocultos)} mensajes anteriores ({fmtInt(ocultos)} sin mostrar)
                      </button>
                    </div>
                  )}
                  {dibujados.map((m) => (
                    <Message key={m.i} m={m} vista={vista} money={money} pedirImagen={pedirImagenSesion} />
                  ))}
                </>
              )}
            </div>

            {agente && (
              <VisorAgente
                agente={agente}
                vista={vista}
                money={money}
                onCerrar={cerrarAgente}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
