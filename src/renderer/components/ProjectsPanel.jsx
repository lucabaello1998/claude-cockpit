import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { basename, fmtInt } from '../util.js';

// Permisos que Claude Code entiende. El formato es Herramienta o
// Herramienta(patrón); los patrones aceptan * al final.
const EJEMPLOS = [
  { v: 'Read', d: 'Leer cualquier archivo sin preguntar' },
  { v: 'Edit', d: 'Editar archivos sin preguntar' },
  { v: 'Write', d: 'Crear archivos sin preguntar' },
  { v: 'Glob', d: 'Buscar archivos por patrón' },
  { v: 'Grep', d: 'Buscar dentro de los archivos' },
  { v: 'Bash(git status:*)', d: 'Solo ese comando de git' },
  { v: 'Bash(npm run test:*)', d: 'Solo los tests' },
  { v: 'Bash(git diff:*)', d: 'Ver diferencias' },
  { v: 'WebFetch(domain:docs.anthropic.com)', d: 'Traer páginas de un dominio' },
];

function Trust({ p, onToggle }) {
  return (
    <button
      className={'btn sm' + (p.trusted ? '' : ' primary')}
      title={p.trusted
        ? 'Claude Code no te pregunta antes de trabajar en esta carpeta. Tocá para revocar.'
        : 'Claude Code te va a preguntar la próxima vez que abras esta carpeta.'}
      onClick={() => onToggle(p, !p.trusted)}
    >
      {p.trusted ? 'Revocar confianza' : 'Confiar'}
    </button>
  );
}

export default function ProjectsPanel({ snap, flash }) {
  const [datos, setDatos] = useState(null);
  const [abierto, setAbierto] = useState(null);
  const [confirmar, setConfirmar] = useState(null);
  const [nuevoPermiso, setNuevoPermiso] = useState('');
  const [nuevoMcp, setNuevoMcp] = useState({ name: '', command: '', args: '' });
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    try { setDatos(await window.cockpit.projectsList()); }
    catch (e) { flash('No se pudieron leer los proyectos: ' + e.message, true); }
  }, [flash]);

  useEffect(() => { cargar(); }, [cargar]);

  // Herramientas que realmente usaste en cada proyecto: es la mejor sugerencia
  // de permisos, mucho mejor que una lista genérica.
  const usadasPorProyecto = useMemo(() => {
    const m = new Map();
    for (const s of snap.sessions || []) {
      const k = String(s.cwd || '').replace(/[\\/]+/g, '/').toLowerCase();
      if (!m.has(k)) m.set(k, {});
      const acc = m.get(k);
      for (const [tool, n] of Object.entries(s.toolCounts || {})) acc[tool] = (acc[tool] || 0) + n;
    }
    return m;
  }, [snap.sessions]);

  // El ejemplo sale de la config de quien esté usando la app, no de una que
  // dejé escrita a mano: en otra máquina sería falso y encima delataría datos
  // del que la armó.
  const ejemplo = useMemo(() => {
    if (!datos) return null;
    for (const pr of datos.proyectos) {
      const m = pr.mcpServers.find((x) => x.command);
      if (m) return { fuente: basename(pr.path), command: m.command, args: m.args || [] };
    }
    const g = datos.disponibles.find((x) => x.command);
    if (g) return { fuente: 'tu configuración global', command: g.command, args: g.args || [] };
    return null;
  }, [datos]);

  const correr = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      await cargar();
      flash(msg);
    } catch (e) {
      flash('No se pudo guardar: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const toggleTrust = (p, valor) => {
    // Revocar reduce privilegios: se hace directo. Otorgar los amplía: se
    // confirma, porque salta la pregunta que normalmente te hace Claude Code.
    if (!valor) return correr(() => window.cockpit.projectSetTrust(p.path, false), 'Confianza revocada');
    setConfirmar(p);
  };

  if (!datos) return <div className="card dim">Cargando…</div>;

  return (
    <div className="grid" style={{ gap: 12 }}>
      {datos.duplicados.length > 0 && (
        <div className="card" style={{ borderColor: 'rgba(217,180,91,0.4)' }}>
          <h3 style={{ color: 'var(--yellow)' }}>
            {datos.duplicados.length} {datos.duplicados.length === 1 ? 'carpeta duplicada' : 'carpetas duplicadas'}
          </h3>
          <p className="dim" style={{ fontSize: 11.5, marginTop: 0 }}>
            La misma carpeta quedó registrada más de una vez con distinta capitalización. Claude Code
            las trata como proyectos distintos, así que los permisos y la confianza no se comparten
            entre ellas.
          </p>
          {datos.duplicados.map((d) => (
            <div key={d.key} className="card" style={{ background: 'var(--panel-2)', marginBottom: 8 }}>
              <b className="mono" style={{ fontSize: 12 }}>{basename(d.key)}</b>
              {d.difierenEnTrust && (
                <span className="chip bad" style={{ marginLeft: 8, fontSize: 10 }}>
                  una está confiada y la otra no
                </span>
              )}
              {d.entradas.map((e) => (
                <div key={e.path} className="row" style={{ gap: 8, marginTop: 6 }}>
                  <span className="mono dim trunc" style={{ flex: 1, fontSize: 11 }}>{e.path}</span>
                  <span className={'chip ' + (e.trusted ? 'on' : '')} style={{ fontSize: 10 }}>
                    {e.trusted ? 'confiada' : 'sin confiar'}
                  </span>
                  <button
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() => correr(
                      () => window.cockpit.projectsMerge(d.entradas.map((x) => x.path), e.path, e.trusted),
                      'Unificadas en una sola entrada'
                    )}
                  >
                    Dejar esta
                  </button>
                </div>
              ))}
              <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
                Al unificar se suman los permisos y los MCP de las dos. La confianza queda como la de
                la entrada que elijas.
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Proyectos registrados ({datos.proyectos.length})</h3>
          <span className="dim right" style={{ fontSize: 11 }}>
            Se hace backup de ~/.claude.json antes de cada cambio
          </span>
        </div>

        {datos.proyectos.map((p) => {
          const key = String(p.path).replace(/[\\/]+/g, '/').toLowerCase();
          const usadas = usadasPorProyecto.get(key) || {};
          const topUsadas = Object.entries(usadas).sort((a, b) => b[1] - a[1]).slice(0, 8);
          const open = abierto === p.path;

          return (
            <div key={p.path} style={{ borderBottom: '1px solid var(--line-soft)', padding: '9px 0' }}>
              <div className="row" style={{ gap: 8 }}>
                <span
                  className="mono trunc"
                  style={{ flex: 1, fontSize: 11.5, cursor: 'pointer' }}
                  title={p.path}
                  onClick={() => setAbierto(open ? null : p.path)}
                >
                  {open ? '▾ ' : '▸ '}{p.path}
                </span>
                {!p.exists && (
                  <span className="chip bad" style={{ fontSize: 10 }} title="La carpeta ya no está en el disco">
                    no existe
                  </span>
                )}
                <span className={'chip ' + (p.trusted ? 'on' : '')} style={{ fontSize: 10 }}>
                  {p.trusted ? 'confiado' : 'sin confiar'}
                </span>
                {p.allowedTools.length > 0 && (
                  <span className="chip info" style={{ fontSize: 10 }}>{p.allowedTools.length} permisos</span>
                )}
                {p.mcpServers.length > 0 && (
                  <span className="chip alt" style={{ fontSize: 10 }}>{p.mcpServers.map((m) => m.name).join(', ')}</span>
                )}
              </div>

              {open && (
                <div style={{ marginTop: 10, paddingLeft: 14 }}>
                  <div className="row" style={{ gap: 6, marginBottom: 12 }}>
                    <Trust p={p} onToggle={toggleTrust} />
                    <button className="btn sm" onClick={() => window.cockpit.openPath(p.path)} disabled={!p.exists}>
                      Abrir carpeta
                    </button>
                    <button
                      className="btn sm right"
                      disabled={busy}
                      onClick={() => correr(() => window.cockpit.projectRemove(p.path), 'Proyecto quitado de la lista')}
                      title="Lo saca de ~/.claude.json. No borra nada del disco."
                    >
                      Quitar de la lista
                    </button>
                  </div>

                  {/* permisos */}
                  <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 5 }}>
                    PERMISOS PREAPROBADOS
                  </div>
                  {p.allowedTools.length === 0 && (
                    <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>
                      Ninguno: Claude Code te pregunta cada vez.
                    </div>
                  )}
                  <div className="row wrap" style={{ gap: 5, marginBottom: 8 }}>
                    {p.allowedTools.map((t) => (
                      <span key={t} className="chip info mono" style={{ fontSize: 10.5 }}>
                        {t}
                        <span
                          style={{ cursor: 'pointer', marginLeft: 4 }}
                          title="Quitar"
                          onClick={() => correr(
                            () => window.cockpit.projectSetTools(p.path, p.allowedTools.filter((x) => x !== t)),
                            'Permiso quitado'
                          )}
                        >×</span>
                      </span>
                    ))}
                  </div>

                  {topUsadas.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
                        Lo que más usás acá (tocá para preaprobar):
                      </div>
                      <div className="row wrap" style={{ gap: 5 }}>
                        {topUsadas.filter(([t]) => !p.allowedTools.includes(t)).map(([t, n]) => (
                          <span
                            key={t}
                            className="chip"
                            style={{ cursor: 'pointer', fontSize: 10.5 }}
                            onClick={() => correr(
                              () => window.cockpit.projectSetTools(p.path, p.allowedTools.concat([t])),
                              'Permiso agregado'
                            )}
                          >
                            + {t} <span className="dim">{fmtInt(n)}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="row" style={{ gap: 6, marginBottom: 12 }}>
                    <input
                      type="text"
                      list="ejemplos-permisos"
                      placeholder="Read · Bash(git status:*) · WebFetch(domain:...)"
                      value={abierto === p.path ? nuevoPermiso : ''}
                      onChange={(e) => setNuevoPermiso(e.target.value)}
                      style={{ flex: 1, fontSize: 11.5 }}
                    />
                    <button
                      className="btn sm"
                      disabled={busy || !nuevoPermiso.trim()}
                      onClick={() => correr(
                        () => window.cockpit.projectSetTools(p.path, p.allowedTools.concat([nuevoPermiso.trim()])),
                        'Permiso agregado'
                      ).then(() => setNuevoPermiso(''))}
                    >
                      Agregar
                    </button>
                  </div>

                  {/* MCP del proyecto */}
                  <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 5 }}>
                    SERVIDORES MCP DE ESTE PROYECTO
                  </div>
                  {p.mcpServers.map((m) => (
                    <div key={m.name} className="row" style={{ gap: 6, marginBottom: 4 }}>
                      <b style={{ fontSize: 12 }}>{m.name}</b>
                      <span className="chip" style={{ fontSize: 10 }}>{m.type}</span>
                      <span className="mono dim trunc" style={{ flex: 1, fontSize: 10.5 }}>
                        {m.command} {(m.args || []).join(' ')}
                      </span>
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={() => correr(
                          () => window.cockpit.projectSetMcp(p.path, p.mcpServers.filter((x) => x.name !== m.name)),
                          'Servidor quitado'
                        )}
                      >
                        Quitar
                      </button>
                    </div>
                  ))}

                  <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
                    {datos.disponibles
                      .filter((d) => !p.mcpServers.some((m) => m.name === d.name))
                      .map((d) => (
                        <span
                          key={d.name}
                          className="chip"
                          style={{ cursor: 'pointer', fontSize: 10.5 }}
                          title={'Copiar la definición global a este proyecto: ' + (d.command || '')}
                          onClick={() => correr(
                            () => window.cockpit.projectSetMcp(p.path, p.mcpServers.concat([d])),
                            'Servidor agregado al proyecto'
                          )}
                        >
                          + {d.name} <span className="dim">(global)</span>
                        </span>
                      ))}
                  </div>

                  <details style={{ marginTop: 8 }}>
                    <summary className="chip" style={{ fontSize: 10.5 }}>Agregar uno nuevo a mano</summary>
                    <div className="row" style={{ gap: 6, marginTop: 8 }}>
                      <input
                        type="text" placeholder="nombre"
                        value={nuevoMcp.name}
                        onChange={(e) => setNuevoMcp({ ...nuevoMcp, name: e.target.value })}
                        style={{ width: 130, fontSize: 11.5 }}
                      />
                      <input
                        type="text" placeholder="comando (ej: npx)"
                        value={nuevoMcp.command}
                        onChange={(e) => setNuevoMcp({ ...nuevoMcp, command: e.target.value })}
                        style={{ width: 150, fontSize: 11.5 }}
                      />
                      <input
                        type="text" placeholder="argumentos separados por espacio"
                        value={nuevoMcp.args}
                        onChange={(e) => setNuevoMcp({ ...nuevoMcp, args: e.target.value })}
                        style={{ flex: 1, fontSize: 11.5 }}
                      />
                      <button
                        className="btn sm"
                        disabled={busy || !nuevoMcp.name.trim() || !nuevoMcp.command.trim()}
                        onClick={() => correr(
                          () => window.cockpit.projectSetMcp(p.path, p.mcpServers.concat([{
                            name: nuevoMcp.name.trim(),
                            type: 'stdio',
                            command: nuevoMcp.command.trim(),
                            args: nuevoMcp.args.trim() ? nuevoMcp.args.trim().split(/\s+/) : [],
                          }])),
                          'Servidor agregado'
                        ).then(() => setNuevoMcp({ name: '', command: '', args: '' }))}
                      >
                        Agregar
                      </button>
                    </div>
                    <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
                      {ejemplo ? (
                        <>
                          Como el que ya tenés en <b>{ejemplo.fuente}</b>:{' '}
                          <span className="mono">{ejemplo.command}</span>
                          {ejemplo.args.length > 0 && (
                            <> con argumentos <span className="mono">{ejemplo.args.join(' ')}</span></>
                          )}
                        </>
                      ) : (
                        <>
                          El comando es el programa que arranca el servidor y los argumentos van
                          separados por espacio. Por ejemplo <span className="mono">npx</span> con{' '}
                          <span className="mono">-y algun-paquete-mcp</span>, o la ruta a un ejecutable
                          sin argumentos.
                        </>
                      )}
                    </div>
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <datalist id="ejemplos-permisos">
        {EJEMPLOS.map((e) => <option key={e.v} value={e.v}>{e.d}</option>)}
      </datalist>

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Cómo se escriben los permisos.</b> Es{' '}
        <span className="mono">Herramienta</span> o <span className="mono">Herramienta(patrón)</span>.
        Sin paréntesis vale para todo uso de esa herramienta; con paréntesis, solo para lo que
        coincida — y el <span className="mono">*</span> al final abre el resto.{' '}
        <span className="mono">Bash(git status:*)</span> preaprueba solo ese comando;{' '}
        <span className="mono">Bash</span> a secas preaprueba cualquier comando de shell, que
        raramente es lo que querés.
        <br /><br />
        <b style={{ color: 'var(--text)' }}>Cerrá Claude Code antes de editar acá.</b> Él también
        escribe <span className="mono">~/.claude.json</span> al terminar cada sesión: si está abierto,
        puede pisar lo que cambies. Siempre queda el backup.
      </div>

      {confirmar && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ maxWidth: 520 }}>
            <b style={{ fontSize: 14 }}>¿Confiar en esta carpeta?</b>
            <div className="mono" style={{ fontSize: 11.5, margin: '10px 0', color: 'var(--muted)' }}>
              {confirmar.path}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              Claude Code pregunta antes de trabajar en una carpeta nueva porque abrirla implica leer
              su <span className="mono">CLAUDE.md</span>, sus hooks y su configuración: es código que
              va a influir en lo que hace. Marcarla como confiada acá <b>saltea esa pregunta</b>.
              <br /><br />
              Hacelo solo con carpetas tuyas o de gente en la que confiás.
            </div>
            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => { const p = confirmar; setConfirmar(null); correr(() => window.cockpit.projectSetTrust(p.path, true), 'Carpeta marcada como confiada'); }}
              >
                Sí, confiar
              </button>
              <button className="btn" onClick={() => setConfirmar(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
