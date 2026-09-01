import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtInt } from '../util.js';
import BoardFilters from './BoardFilters.jsx';
import CardDetail from './CardDetail.jsx';

const NIVEL = {
  hito: { label: 'Hito', color: '#a98bd4' },
  feature: { label: 'Feature', color: '#6c9fd8' },
  pbi: { label: 'PBI', color: '#d97757' },
  task: { label: 'Task', color: '#7cae7a' },
};
const ORDEN = ['hito', 'feature', 'pbi', 'task'];

function Tarjeta({ t, board, onAbrir, onArrastrar, indent }) {
  const n = NIVEL[t.nivel] || NIVEL.pbi;
  return (
    <div
      draggable={!board.remoto}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); onArrastrar(t.id); }}
      onClick={() => onAbrir(t)}
      className="tarjeta"
      style={{ marginLeft: indent * 12, borderLeftColor: n.color }}
      title="Abrir el detalle"
    >
      <div className="row" style={{ gap: 5, marginBottom: 3 }}>
        <span className="chip" style={{ fontSize: 9.5, borderColor: n.color, color: n.color, padding: '0 6px' }}>
          {t.tipoOriginal || n.label}
        </span>
        {board.remoto && <span className="dim" style={{ fontSize: 9.5 }}>#{t.id}</span>}
        {t.estimacion > 0 && <span className="chip dim" style={{ fontSize: 9.5 }}>{t.estimacion}</span>}
        {t.origen && <span className="chip dim" style={{ fontSize: 9.5 }} title={t.origen.proveedor}>↗</span>}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.4 }}>{t.titulo}</div>
      <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
        {t.asignado && <span className="dim" style={{ fontSize: 10 }}>{t.asignado}</span>}
        {t.sprint && <span className="chip dim" style={{ fontSize: 9 }}>{t.sprint}</span>}
      </div>
      {(t.etiquetas || []).length > 0 && (
        <div className="row wrap" style={{ gap: 3, marginTop: 4 }}>
          {t.etiquetas.slice(0, 3).map((e) => (
            <span key={e} className="chip dim" style={{ fontSize: 9 }}>{e}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Los tableros propios se filtran en memoria: ya estan cargados enteros y asi
// el filtro es instantaneo. Los de ADO se filtran en la consulta.
function filtrarLocal(tarjetas, f) {
  const filtros = f || {};
  const niveles = filtros.niveles || [];
  const estados = filtros.estados || [];
  const texto = String(filtros.texto || '').toLowerCase();
  return (tarjetas || []).filter((t) => {
    if (niveles.length && !niveles.includes(t.nivel)) return false;
    if (estados.length && !estados.includes(t.columna)) return false;
    if (filtros.responsable === '__sin_asignar__' && t.asignado) return false;
    if (filtros.responsable && filtros.responsable !== '__sin_asignar__'
      && t.asignado !== filtros.responsable) return false;
    if (filtros.sprint && t.sprint !== filtros.sprint) return false;
    if (texto && !String(t.titulo || '').toLowerCase().includes(texto)) return false;
    return true;
  });
}

export default function BoardsPanel({ flash }) {
  const [prov, setProv] = useState(null);
  const [modo, setModo] = useState('local');
  const [locales, setLocales] = useState([]);
  const [boardId, setBoardId] = useState('');
  const [board, setBoard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editando, setEditando] = useState(null);
  const [editCols, setEditCols] = useState(null);
  const [arrastrada, setArrastrada] = useState(null);
  const [filtros, setFiltros] = useState({});
  const [verTarjeta, setVerTarjeta] = useState(null);

  // Arrastrar el tablero.
  //
  // El scroll horizontal lo tiene .tablero y el vertical la pagina (.content),
  // asi que un solo gesto mueve los dos. Con el boton izquierdo solo agarra el
  // fondo: sobre una tarjeta manda el arrastre de la tarjeta, que es como se
  // mueve entre columnas. El boton del medio agarra siempre.
  const tableroRef = useRef(null);
  const pan = useRef(null);

  const empezarPan = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && e.target.closest('.tarjeta')) return;
    const cont = tableroRef.current;
    if (!cont) return;
    const vertical = cont.closest('.content');
    pan.current = {
      x: e.clientX, y: e.clientY,
      izq: cont.scrollLeft,
      arriba: vertical ? vertical.scrollTop : 0,
      cont, vertical, movido: false,
    };
    cont.classList.add('agarrando');
    e.preventDefault();
  };

  useEffect(() => {
    const mover = (e) => {
      const p = pan.current;
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.movido && Math.abs(dx) + Math.abs(dy) > 3) p.movido = true;
      p.cont.scrollLeft = p.izq - dx;
      if (p.vertical) p.vertical.scrollTop = p.arriba - dy;
    };
    const soltar = () => {
      const p = pan.current;
      if (!p) return;
      p.cont.classList.remove('agarrando');
      pan.current = null;
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
    return () => {
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
    };
  }, []);

  // Azure DevOps
  const [conexion, setConexion] = useState(null);
  const [proyectos, setProyectos] = useState(null);
  const [proyecto, setProyecto] = useState('');
  const [equipos, setEquipos] = useState([]);
  const [equipo, setEquipo] = useState('');
  const [sprints, setSprints] = useState([]);
  // La lista de responsables sale de las tarjetas que se ven. Si se guardara
  // tal cual, filtrar por "Mías" dejaba el desplegable con una sola persona y
  // no se podia reasignar a nadie mas. Se acumula: nunca se achica.
  const [roster, setRoster] = useState([]);

  // Se juntan los responsables vistos hasta ahora, sin repetir. La cuenta se
  // toma de la ultima vez que aparecieron, que es la que corresponde a lo que
  // se esta mirando.
  const sumarAlRoster = useCallback((nuevos) => {
    setRoster((viejos) => {
      const m = new Map(viejos.map((r) => [r.valor, r]));
      for (const r of nuevos || []) {
        if (r.valor === '__sin_asignar__') continue;
        m.set(r.valor, { ...(m.get(r.valor) || {}), ...r });
      }
      return [...m.values()].sort((a, b) => String(a.etiqueta).localeCompare(String(b.etiqueta)));
    });
  }, []);

  const cargarLocales = useCallback(async () => {
    const l = await window.cockpit.boardsList();
    setLocales(l);
    return l;
  }, []);

  useEffect(() => {
    window.cockpit.boardsProviders().then(setProv).catch(() => setProv([]));
    window.cockpit.adoConnection().then(setConexion).catch(() => setConexion({ conectado: false }));
    cargarLocales().catch(() => {});
  }, [cargarLocales]);

  const abrirLocal = useCallback(async (bid) => {
    if (!bid) { setBoard(null); return; }
    setBusy(true);
    try { setBoard(await window.cockpit.boardGet(bid)); setBoardId(bid); }
    catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }, [flash]);

  const correr = async (fn, msg) => {
    setBusy(true);
    try {
      const b = await fn();
      if (b && b.tarjetas) setBoard(b);
      else if (boardId) setBoard(await window.cockpit.boardGet(boardId));
      await cargarLocales();
      if (msg) flash(msg);
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  // --- Azure DevOps ---------------------------------------------------------

  const cargarAdo = async () => {
    setBusy(true);
    try { setProyectos(await window.cockpit.adoProjects()); }
    catch (e) { flash('Azure DevOps: ' + e.message, true); }
    finally { setBusy(false); }
  };

  // El tablero remoto se vuelve a pedir cada vez que cambian los filtros,
  // porque el filtrado ocurre en la consulta WIQL, no en memoria.
  const pedirAdo = useCallback(async (pr, eq, f) => {
    if (!pr) return;
    setBusy(true);
    try {
      const b = await window.cockpit.adoBoard(pr, eq, f || {});
      setBoard(b);
      sumarAlRoster(b.responsables);
    } catch (e) { flash('Azure DevOps: ' + e.message, true); }
    finally { setBusy(false); }
  }, [flash, sumarAlRoster]);

  // El texto se escribe letra por letra: sin esto seria una consulta por tecla.
  const timerTexto = useRef(null);
  const cambiarFiltros = useCallback((nuevos) => {
    setFiltros(nuevos);
    if (modo !== 'ado' || !proyecto) return;
    clearTimeout(timerTexto.current);
    const demora = nuevos.texto !== filtros.texto ? 450 : 0;
    timerTexto.current = setTimeout(() => pedirAdo(proyecto, equipo, nuevos), demora);
  }, [modo, proyecto, equipo, filtros.texto, pedirAdo]);

  useEffect(() => () => clearTimeout(timerTexto.current), []);

  const elegirProyecto = async (pr) => {
    setProyecto(pr); setEquipo(''); setBoard(null); setEquipos([]); setSprints([]); setRoster([]);
    if (!pr) return;
    setBusy(true);
    try {
      const eqs = await window.cockpit.adoTeams(pr);
      setEquipos(eqs);
      // Casi siempre hay un solo equipo: se elige solo y se abre el tablero.
      if (eqs.length === 1) await elegirEquipo(pr, eqs[0].name);
    } catch (e) { flash('Azure DevOps: ' + e.message, true); }
    finally { setBusy(false); }
  };

  const elegirEquipo = async (pr, eq) => {
    setEquipo(eq);
    if (!eq) return;
    try { setSprints(await window.cockpit.adoSprints(pr, eq)); }
    catch { setSprints([]); }
    await pedirAdo(pr, eq, filtros);
  };

  const jiraProyectos = async () => {
    setBusy(true);
    try { setProyectos(await window.cockpit.jiraProjects()); }
    catch (e) { flash('Jira: ' + e.message, true); }
    finally { setBusy(false); }
  };

  const provDe = (id) => (prov || []).find((x) => x.id === id);

  // --- vista ----------------------------------------------------------------

  const remoto = !!(board && board.remoto);

  // En un tablero propio el filtro se aplica aca; en uno remoto ya vino
  // filtrado de la consulta.
  const tarjetasVisibles = useMemo(
    () => (!board ? [] : (remoto ? board.tarjetas : filtrarLocal(board.tarjetas, filtros))),
    [board, remoto, filtros]
  );

  const porColumna = useMemo(() => {
    if (!board) return {};
    const visibles = new Set(tarjetasVisibles.map((t) => t.id));
    const out = {};
    const hijosDe = new Map();
    for (const t of board.tarjetas) {
      const k = t.padre || '__raiz__';
      if (!hijosDe.has(k)) hijosDe.set(k, []);
      hijosDe.get(k).push(t);
    }
    // Un hijo cuyo padre quedo fuera del filtro igual tiene que verse: se
    // recorre todo el arbol y se dibuja solo lo visible, sin sangria huerfana.
    for (const c of board.columnas) {
      const lista = [];
      const visitar = (t, nivel) => {
        const entra = visibles.has(t.id) && t.columna === c.id;
        if (entra) lista.push({ t, indent: Math.min(nivel, 3) });
        for (const h of hijosDe.get(t.id) || []) visitar(h, entra ? nivel + 1 : nivel);
      };
      for (const raiz of hijosDe.get('__raiz__') || []) visitar(raiz, 0);
      out[c.id] = lista;
    }
    return out;
  }, [board, tarjetasVisibles]);

  const soltar = (columna) => {
    if (!arrastrada || !board || board.remoto) return;
    correr(() => window.cockpit.boardMoveCard(boardId, arrastrada, columna));
    setArrastrada(null);
  };

  const estadosDelTablero = useMemo(
    () => (board ? board.columnas.map((c) => c.id) : []),
    [board]
  );

  const refrescar = useCallback(() => {
    if (remoto) pedirAdo(proyecto, equipo, filtros);
    else if (boardId) abrirLocal(boardId);
  }, [remoto, proyecto, equipo, filtros, boardId, pedirAdo, abrirLocal]);

  return (
    <div className="grid" style={{ gap: 12 }}>

      {/* Conexión: antes había que adivinar si estabas conectado. */}
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <button
          className={'btn sm' + (modo === 'local' ? ' primary' : '')}
          onClick={() => { setModo('local'); setBoard(null); setFiltros({}); }}
        >
          Tableros propios
        </button>
        <button
          className={'btn sm' + (modo === 'ado' ? ' primary' : '')}
          onClick={() => {
            setModo('ado'); setBoard(null); setFiltros({});
            if (!proyectos) cargarAdo();
          }}
          disabled={!!prov && !(provDe('azure-devops') || {}).disponible}
          title={prov && !(provDe('azure-devops') || {}).disponible
            ? 'Necesitás un servidor MCP llamado "ado"'
            : 'Tus work items reales de Azure DevOps'}
        >
          Azure DevOps
        </button>
        <button
          className={'btn sm' + (modo === 'jira' ? ' primary' : '')}
          onClick={() => { setModo('jira'); setBoard(null); setProyectos(null); setFiltros({}); jiraProyectos(); }}
          disabled={!!prov && !(provDe('jira') || {}).disponible}
          title={prov && !(provDe('jira') || {}).disponible
            ? 'Necesitás un servidor MCP de Jira o Atlassian configurado en Claude Code'
            : 'Tus proyectos de Jira'}
        >
          Jira
        </button>

        {busy && <span className="spin" />}

        {modo === 'ado' && conexion && (
          <span className="chip" style={{ fontSize: 10.5 }} title={conexion.definidoPor ? 'Definido por ' + conexion.definidoPor : ''}>
            {conexion.conectado
              ? <>conectado a <b>{conexion.organizacion || 'Azure DevOps'}</b></>
              : 'sin conexión'}
          </span>
        )}
        {modo === 'ado' && conexion && !conexion.conectado && (
          <span className="dim" style={{ fontSize: 11 }}>
            {conexion.motivo} Agregalo desde Configuración → MCP.
          </span>
        )}

        {/* Los selectores van en esta misma fila: separarlos en otra linea
            gastaba alto de pantalla que le hace falta al tablero. */}
        {modo === 'local' && (
          <>
            <select value={boardId} onChange={(e) => abrirLocal(e.target.value)} style={{ fontSize: 11.5, minWidth: 190 }}>
              <option value="">Elegí un tablero…</option>
              {locales.map((b) => <option key={b.id} value={b.id}>{b.nombre} ({b.tarjetas})</option>)}
            </select>
            <button
              className="btn sm"
              onClick={() => {
                const n = window.prompt('Nombre del tablero:');
                if (n) correr(async () => { const b = await window.cockpit.boardCreate(n); setBoardId(b.id); return b; }, 'Tablero creado');
              }}
            >
              Nuevo
            </button>
          </>
        )}

        {modo === 'ado' && proyectos && (
          <>
            <select value={proyecto} onChange={(e) => elegirProyecto(e.target.value)} style={{ fontSize: 11.5, minWidth: 175 }}>
              <option value="">Proyecto…</option>
              {proyectos.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
            {equipos.length > 0 && (
              <select
                value={equipo} onChange={(e) => elegirEquipo(proyecto, e.target.value)}
                style={{ fontSize: 11.5, minWidth: 165 }}
              >
                <option value="">Equipo…</option>
                {equipos.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            )}
          </>
        )}

        {modo === 'jira' && proyectos && (
          <>
            <select value={proyecto} onChange={(e) => { setProyecto(e.target.value); setBoard(null); }} style={{ fontSize: 11.5, minWidth: 190 }}>
              <option value="">Proyecto…</option>
              {proyectos.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.id})</option>)}
            </select>
            {proyecto && (
              <button
                className="btn sm"
                onClick={async () => {
                  setBusy(true);
                  try { setBoard(await window.cockpit.jiraBoard(proyecto)); }
                  catch (e) { flash('Jira: ' + e.message, true); }
                  finally { setBusy(false); }
                }}
              >
                Cargar
              </button>
            )}
          </>
        )}

        <div className="right row" style={{ gap: 6 }}>
          {board && board.board && (
            <span className="chip" style={{ fontSize: 10.5 }} title="Columnas tal cual las tiene configuradas el equipo en Azure DevOps">
              board <b>{board.board}</b>
            </span>
          )}
          {board && (
            <button className="btn sm" onClick={refrescar} disabled={busy} title="Volver a pedir los datos">
              Actualizar
            </button>
          )}
          {board && remoto && (
            <button
              className="btn sm"
              onClick={() => {
                const n = window.prompt('Nombre del tablero propio:', board.nombre);
                if (n) correr(() => window.cockpit.boardImport(board, n), 'Importado como tablero propio');
              }}
              title="Copiarlo a un tablero propio para trabajarlo sin tocar el original"
            >
              Importar
            </button>
          )}
          {board && !remoto && (
            <>
              <button
                className="btn sm"
                onClick={() => {
                  if (window.confirm('¿Borrar el tablero "' + board.nombre + '" y todas sus tarjetas?')) {
                    correr(async () => { await window.cockpit.boardDelete(boardId); setBoard(null); setBoardId(''); }, 'Tablero borrado');
                  }
                }}
              >
                Borrar
              </button>
              <button className="btn sm" onClick={() => setEditCols(board.columnas.map((c) => ({ ...c })))}>
                Columnas
              </button>
              <button
                className="btn sm primary"
                onClick={() => setEditando({
                  titulo: '', nivel: 'pbi', columna: board.columnas[0] && board.columnas[0].id,
                  padre: '', descripcion: '', estimacion: '', asignado: '', sprint: '',
                })}
              >
                Nueva tarjeta
              </button>
            </>
          )}
        </div>
      </div>

      {board && (
        <BoardFilters
          filtros={filtros}
          onCambio={cambiarFiltros}
          responsables={board.responsables || []}
          sprints={remoto ? sprints : (board.sprints || [])}
          estados={estadosDelTablero}
          remoto={remoto}
          cargando={busy}
          resumen={`${fmtInt(tarjetasVisibles.length)}${!remoto && tarjetasVisibles.length !== board.tarjetas.length ? ' de ' + fmtInt(board.tarjetas.length) : ''} tarjetas`}
        />
      )}

      {/* Las columnas reales del board solo existen para un nivel a la vez:
          en ADO el tablero siempre muestra un nivel del backlog. */}
      {board && remoto && !board.board && (
        <div className="chip" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11.5 }}>
          Estás viendo columnas armadas con los estados. Elegí <b>un</b> nivel
          (Hitos, Features, PBIs o Tasks) para ver las columnas reales del board
          del equipo, con sus nombres, su orden y sus límites WIP.
        </div>
      )}

      {board && board.aviso && (
        <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', fontSize: 11.5 }}>
          {board.aviso}
        </div>
      )}

      {!board ? (
        <div className="card dim" style={{ fontSize: 12 }}>
          {modo === 'local'
            ? 'Elegí un tablero o creá uno nuevo. La jerarquía es Hito → Feature → PBI → Task, y las columnas se personalizan.'
            : modo === 'jira'
              ? 'Elegí un proyecto de Jira para ver sus issues.'
              : 'Elegí un proyecto de Azure DevOps. Después vas a poder filtrar por nivel, responsable, sprint y estado.'}
        </div>
      ) : (
        <div className="tablero" ref={tableroRef} onMouseDown={empezarPan}>
          {board.columnas.map((c) => {
            const lista = porColumna[c.id] || [];
            const excede = c.wip > 0 && lista.length > c.wip;
            return (
              <div
                key={c.id}
                className="columna"
                onDragOver={(e) => { if (!board.remoto) e.preventDefault(); }}
                onDrop={() => soltar(c.id)}
              >
                <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                  <b style={{ fontSize: 12 }}>{c.titulo}</b>
                  <span className={'chip ' + (excede ? 'bad' : 'dim')} style={{ fontSize: 10 }}
                    title={c.wip > 0 ? 'Límite WIP del board' : ''}>
                    {lista.length}{c.wip > 0 ? ` / ${c.wip}` : ''}
                  </span>
                  {c.fueraDelBoard && (
                    <span className="chip warn" style={{ fontSize: 9 }} title="Esta columna no está en la configuración del board">
                      fuera del board
                    </span>
                  )}
                </div>
                {lista.map(({ t, indent }) => (
                  <Tarjeta
                    key={t.id} t={t} board={board} indent={indent}
                    onArrastrar={setArrastrada}
                    onAbrir={setVerTarjeta}
                  />
                ))}
                {!lista.length && <div className="dim" style={{ fontSize: 11, padding: '8px 0' }}>vacía</div>}
              </div>
            );
          })}
        </div>
      )}

      {board && (
        <div className="card dim" style={{ fontSize: 11.5 }}>
          {fmtInt(tarjetasVisibles.length)} tarjetas ·{' '}
          {ORDEN.map((n) => {
            const c = tarjetasVisibles.filter((t) => t.nivel === n).length;
            return c ? `${c} ${NIVEL[n].label}${c > 1 ? 's' : ''}` : null;
          }).filter(Boolean).join(' · ')}
          {' · clic en una tarjeta para ver todo'}
          {!board.remoto && ' · arrastrala entre columnas para moverla'}
          {' · arrastrá el fondo (o con el botón del medio) para mover el tablero'}
        </div>
      )}

      {verTarjeta && (
        <div className="capa-detalle">
          <CardDetail
            tarjeta={verTarjeta}
            remoto={remoto}
            proyecto={proyecto}
            boardId={boardId}
            responsables={remoto ? roster : (board ? board.responsables : [])}
            sprints={remoto ? sprints : (board ? board.sprints : [])}
            columnas={board ? board.columnas : []}
            onCerrar={() => setVerTarjeta(null)}
            onCambio={refrescar}
            flash={flash}
          />
        </div>
      )}

      {editando && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ width: 560, maxWidth: '95vw' }}>
            <b style={{ fontSize: 14 }}>{editando.id ? 'Editar tarjeta' : 'Nueva tarjeta'}</b>
            <input
              type="text" placeholder="título" value={editando.titulo}
              onChange={(e) => setEditando({ ...editando, titulo: e.target.value })}
              style={{ width: '100%', margin: '10px 0 6px' }}
            />
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <select value={editando.nivel} onChange={(e) => setEditando({ ...editando, nivel: e.target.value })} style={{ fontSize: 11.5 }}>
                {ORDEN.map((n) => <option key={n} value={n}>{NIVEL[n].label}</option>)}
              </select>
              <select value={editando.columna} onChange={(e) => setEditando({ ...editando, columna: e.target.value })} style={{ fontSize: 11.5 }}>
                {board.columnas.map((c) => <option key={c.id} value={c.id}>{c.titulo}</option>)}
              </select>
              <select value={editando.padre || ''} onChange={(e) => setEditando({ ...editando, padre: e.target.value })} style={{ fontSize: 11.5, flex: 1 }}>
                <option value="">Sin padre</option>
                {board.tarjetas.filter((t) => t.id !== editando.id).map((t) => (
                  <option key={t.id} value={t.id}>{NIVEL[t.nivel].label}: {t.titulo.slice(0, 40)}</option>
                ))}
              </select>
              <input
                type="number" min="0" placeholder="pts" value={editando.estimacion}
                onChange={(e) => setEditando({ ...editando, estimacion: e.target.value })}
                style={{ width: 70, fontSize: 11.5 }}
              />
            </div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <input
                type="text" placeholder="responsable" value={editando.asignado || ''}
                onChange={(e) => setEditando({ ...editando, asignado: e.target.value })}
                style={{ flex: 1, fontSize: 11.5 }}
              />
              <input
                type="text" placeholder="sprint" value={editando.sprint || ''}
                onChange={(e) => setEditando({ ...editando, sprint: e.target.value })}
                style={{ flex: 1, fontSize: 11.5 }}
                list="sprints-propios"
              />
              <datalist id="sprints-propios">
                {(board.sprints || []).map((s) => <option key={s.id} value={s.nombre} />)}
              </datalist>
            </div>
            <textarea
              placeholder="descripción…" value={editando.descripcion || ''}
              onChange={(e) => setEditando({ ...editando, descripcion: e.target.value })}
              style={{ width: '100%', minHeight: 90, fontFamily: 'inherit' }}
            />
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button
                className="btn primary" disabled={busy || !editando.titulo.trim()}
                onClick={() => correr(
                  () => window.cockpit.boardSaveCard(boardId, editando),
                  editando.id ? 'Tarjeta guardada' : 'Tarjeta creada'
                ).then(() => setEditando(null))}
              >
                Guardar
              </button>
              <button className="btn" onClick={() => setEditando(null)}>Cancelar</button>
              {editando.id && (
                <button
                  className="btn right" disabled={busy}
                  onClick={() => correr(
                    () => window.cockpit.boardDeleteCard(boardId, editando.id), 'Tarjeta borrada'
                  ).then(() => setEditando(null))}
                >
                  Borrar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {editCols && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ width: 520, maxWidth: '95vw' }}>
            <b style={{ fontSize: 14 }}>Columnas</b>
            <div className="dim" style={{ fontSize: 11, margin: '4px 0 10px' }}>
              El límite WIP marca en rojo cuando una columna se pasa. 0 = sin límite.
            </div>
            {editCols.map((c, i) => (
              <div key={i} className="row" style={{ gap: 6, marginBottom: 6 }}>
                <input
                  type="text" value={c.titulo}
                  onChange={(e) => setEditCols(editCols.map((x, j) => j === i ? { ...x, titulo: e.target.value } : x))}
                  style={{ flex: 1, fontSize: 11.5 }}
                />
                <input
                  type="number" min="0" value={c.wip || 0} title="límite WIP"
                  onChange={(e) => setEditCols(editCols.map((x, j) => j === i ? { ...x, wip: e.target.value } : x))}
                  style={{ width: 70, fontSize: 11.5 }}
                />
                <button className="btn sm" onClick={() => setEditCols(editCols.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button
              className="btn sm" style={{ marginTop: 4 }}
              onClick={() => setEditCols(editCols.concat([{ id: 'col' + Date.now(), titulo: 'Nueva', wip: 0 }]))}
            >
              Agregar columna
            </button>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button
                className="btn primary" disabled={busy}
                onClick={() => correr(
                  () => window.cockpit.boardSaveColumns(boardId, editCols), 'Columnas guardadas'
                ).then(() => setEditCols(null))}
              >
                Guardar
              </button>
              <button className="btn" onClick={() => setEditCols(null)}>Cancelar</button>
              <span className="dim right" style={{ fontSize: 11 }}>
                Si borrás una, sus tarjetas van a la primera
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
