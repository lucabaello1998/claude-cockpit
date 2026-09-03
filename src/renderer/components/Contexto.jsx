import React, { useCallback, useEffect, useState } from 'react';
import { fmtBytes, fmtAgo } from '../util.js';
import LlevarContexto from './LlevarContexto.jsx';

// Qué sabe Claude Code cuando arranca una sesión nueva en cada proyecto.
//
// Claude Code ya lee solo `~/.claude/projects/<proy>/memory/*.md` y el
// `CLAUDE.md` del repo. Acá no se inventa un formato nuevo — eso significaría
// que Claude Code no lo lee, que es justo lo que no sirve. Se hace visible lo
// que ya existe, se deja editar, y se ayuda a llenarlo.

const TIPOS = [
  { id: 'project', label: 'Proyecto', ayuda: 'Trabajo en curso, objetivos, restricciones que no se deducen del código' },
  { id: 'feedback', label: 'Cómo trabajar', ayuda: 'Correcciones tuyas sobre la forma de trabajar. Incluí el porqué' },
  { id: 'user', label: 'Sobre vos', ayuda: 'Quién sos, tu rol, tus preferencias' },
  { id: 'reference', label: 'Referencia', ayuda: 'Links a recursos externos, tableros, tickets' },
];

function Editor({ proyecto, memoria, onCerrar, onGuardado, flash }) {
  const [datos, setDatos] = useState({
    name: memoria ? memoria.name : '',
    description: memoria ? memoria.description : '',
    type: memoria ? memoria.type : 'project',
    body: '',
    file: memoria ? memoria.file : null,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!memoria) return;
    window.cockpit.memoryRead(proyecto.projectDir, memoria.file)
      .then((raw) => {
        // Se separa el frontmatter para editar solo el cuerpo.
        const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
        setDatos((d) => ({ ...d, body: (m ? m[1] : raw).trim() }));
      })
      .catch(() => {});
  }, [proyecto, memoria]);

  const guardar = async () => {
    setBusy(true);
    try {
      await window.cockpit.memorySave(proyecto.projectDir, datos);
      flash('Memoria guardada');
      onGuardado();
      onCerrar();
    } catch (e) {
      flash(String(e.message || e).replace(/^Error:\s*/, ''), true);
    } finally { setBusy(false); }
  };

  const tipo = TIPOS.find((t) => t.id === datos.type) || TIPOS[0];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div className="card" style={{ width: 640, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}>
        <b style={{ fontSize: 14 }}>{memoria ? 'Editar memoria' : 'Nueva memoria'}</b>
        <div className="dim" style={{ fontSize: 11, marginTop: 3, marginBottom: 10 }}>
          en {proyecto.nombre}
        </div>

        <input
          type="text" placeholder="nombre corto (ej: por-que-usamos-nsis)"
          value={datos.name} onChange={(e) => setDatos({ ...datos, name: e.target.value })}
          style={{ width: '100%', marginBottom: 6 }}
        />
        <input
          type="text" placeholder="una línea que diga de qué se trata"
          value={datos.description} onChange={(e) => setDatos({ ...datos, description: e.target.value })}
          style={{ width: '100%', marginBottom: 6 }}
        />
        <div className="dim" style={{ fontSize: 10.5, marginBottom: 8 }}>
          La descripción es lo que Claude usa para decidir si esta memoria viene al caso. Si es vaga, no se va a usar.
        </div>

        <div className="row wrap" style={{ gap: 5, marginBottom: 4 }}>
          {TIPOS.map((t) => (
            <button
              key={t.id}
              className={'btn sm' + (datos.type === t.id ? ' primary' : '')}
              onClick={() => setDatos({ ...datos, type: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 10.5, marginBottom: 8 }}>{tipo.ayuda}</div>

        <textarea
          placeholder="El hecho. Para 'Cómo trabajar', agregá por qué y cómo aplicarlo."
          value={datos.body} onChange={(e) => setDatos({ ...datos, body: e.target.value })}
          style={{ width: '100%', minHeight: 160, fontFamily: 'inherit', fontSize: 12.5 }}
        />

        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn primary" disabled={busy || !datos.name.trim() || !datos.description.trim()} onClick={guardar}>
            Guardar
          </button>
          <button className="btn" onClick={onCerrar}>Cancelar</button>
          {memoria && (
            <button
              className="btn right" disabled={busy}
              onClick={async () => {
                if (!window.confirm('¿Borrar "' + memoria.name + '"?')) return;
                try {
                  await window.cockpit.memoryDelete(proyecto.projectDir, memoria.file);
                  flash('Memoria borrada'); onGuardado(); onCerrar();
                } catch (e) { flash(String(e.message || e), true); }
              }}
            >
              Borrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// La skill `cockpit-memory` deja pedir este contexto desde CUALQUIER sesion de
// Claude Code, sin tener Cockpit abierto. Cockpit mantiene el catalogo; la
// skill solo sabe leerlo.
function Skill({ total, flash }) {
  const [est, setEst] = useState(null);
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(() => {
    window.cockpit.skillStatus().then(setEst).catch(() => setEst(null));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  if (!est) return null;

  const accion = async (fn, msg) => {
    setBusy(true);
    try { await fn(); flash(msg); cargar(); }
    catch (e) { flash(String(e.message || e).replace(/^Error:\s*/, ''), true); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--blue)' }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 13 }}>Traer este contexto desde cualquier sesión</b>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.6 }}>
            {est.instalada ? (
              <>
                Escribí <code>/{est.nombre}</code> en cualquier sesión de Claude Code y te
                muestra la lista para elegir qué traer. El catálogo ({total} memorias) se
                actualiza solo cada vez que Cockpit reindexa.
              </>
            ) : (
              <>
                Se instala una skill en <code>~/.claude/skills/{est.nombre}</code>. Después,
                escribiendo <code>/{est.nombre}</code> en cualquier sesión podés traer estas
                memorias sin tener Cockpit abierto.
              </>
            )}
          </div>
          <div className="dim" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.55 }}>
            Los grafos de código no se traen enteros: tienen decenas de miles de nodos. Lo
            que viaja es el puntero — que existen, de qué commit son, y con qué
            herramientas se consultan.
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {busy && <span className="spin" />}
          {est.instalada ? (
            <>
              <button className="btn sm" onClick={() => window.cockpit.openPath(est.dir)}>Ver</button>
              <button
                className="btn sm"
                onClick={() => accion(() => window.cockpit.skillUninstall(), 'Skill quitada')}
              >
                Quitar
              </button>
            </>
          ) : (
            <button
              className="btn sm primary"
              onClick={() => accion(() => window.cockpit.skillInstall(), 'Skill instalada')}
            >
              Instalar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Contexto({ flash }) {
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null);
  const [armando, setArmando] = useState(false);

  const cargar = useCallback(async () => {
    try { setLista(await window.cockpit.contextByProject()); }
    catch { setLista([]); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (!lista) return <div className="card dim">Revisando…</div>;

  const vacios = lista.filter((p) => p.vacio).length;
  const totalMem = lista.reduce((a, p) => a + p.memorias.length, 0);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.65, maxWidth: 680 }}>
        Esto es lo que Claude Code carga solo al abrir una sesión en cada proyecto. Es el
        mecanismo que evita perder contexto cuando una sesión se compacta, cuando abrís
        una nueva, o cuando te vas a otra máquina.
        {vacios > 0 && (
          <> <b style={{ color: 'var(--yellow)' }}>
            {vacios === 1 ? 'Hay 1 proyecto sin nada guardado' : `Hay ${vacios} proyectos sin nada guardado`}
          </b>: una sesión nueva ahí arranca en blanco.</>
        )}
      </div>

      <Skill total={totalMem} flash={flash} />

      {/* La skill trae contexto de acá; esto lo saca. Van juntos porque son la
          misma pregunta desde los dos lados: qué sobrevive a esta sesión. */}
      <div className="card row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Llevarte contexto elegido</b>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.6 }}>
            Tildás qué memorias, qué CLAUDE.md y qué conversaciones querés, y sale una
            carpeta que se importa desde cualquier sesión con <code>/cockpit-memory
            importar</code>. Sirve para traer contexto viejo acá, o para llevártelo a otra
            máquina.
          </div>
        </div>
        <button className="btn sm primary" onClick={() => setArmando(true)}>Armar carpeta</button>
      </div>

      {armando && <LlevarContexto onCerrar={() => setArmando(false)} flash={flash} />}

      {lista.map((p) => (
        <div
          key={p.projectDir}
          className="card"
          style={p.vacio ? { borderLeft: '3px solid var(--yellow)' } : null}
        >
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b className="trunc" style={{ fontSize: 13 }} title={p.projectPath || p.projectDir}>
                {p.nombre}
              </b>
              <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>
                {p.memorias.length
                  ? `${p.memorias.length} memoria${p.memorias.length > 1 ? 's' : ''}`
                  : 'sin memorias'}
                {p.claudeMd ? ' · CLAUDE.md (' + fmtBytes(p.claudeMd.bytes) + ')' : ' · sin CLAUDE.md'}
                {!p.indice && p.memorias.length ? ' · sin índice MEMORY.md' : ''}
              </div>
            </div>
            <button className="btn sm" onClick={() => setEditando({ proyecto: p, memoria: null })}>
              Agregar
            </button>
            {p.projectPath && (
              <button className="btn sm" onClick={() => window.cockpit.openPath(p.dir)}>
                Abrir carpeta
              </button>
            )}
          </div>

          {p.memorias.map((m) => (
            <div
              key={m.file}
              className="row"
              style={{
                gap: 8, alignItems: 'flex-start', padding: '7px 0',
                borderTop: '1px solid var(--line-soft)', cursor: 'pointer',
              }}
              onClick={() => setEditando({ proyecto: p, memoria: m })}
            >
              <span className="chip dim" style={{ fontSize: 9.5, flex: '0 0 auto' }}>{m.type || 'project'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12 }}>{m.name}</div>
                <div className="dim" style={{ fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>
                  {m.description || <i>sin descripción — Claude no va a saber cuándo usarla</i>}
                </div>
              </div>
              <span className="dim" style={{ fontSize: 10, flex: '0 0 auto' }}>
                {m.mtimeMs ? fmtAgo(new Date(m.mtimeMs).toISOString()) : ''}
              </span>
            </div>
          ))}

          {p.vacio && (
            <div className="dim" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
              Una sesión nueva en este proyecto no sabe nada de lo que ya hiciste. Desde
              Conversaciones podés pedirle a Claude Code que las escriba a partir de una
              conversación vieja.
            </div>
          )}
        </div>
      ))}

      {editando && (
        <Editor
          proyecto={editando.proyecto}
          memoria={editando.memoria}
          onCerrar={() => setEditando(null)}
          onGuardado={cargar}
          flash={flash}
        />
      )}
    </div>
  );
}
