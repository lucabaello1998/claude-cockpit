import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtAgo, fmtBytes, fmtInt } from '../util.js';

const ORIGEN_CHIP = { usuario: 'on', proyecto: 'info', plugin: 'alt', integrada: '' };

const AYUDA_ORIGEN = {
  usuario: 'Está en ~/.claude/skills. Es tuya: se puede editar y borrar.',
  proyecto: 'Vive dentro del repositorio. Se puede editar, y el cambio viaja con el código.',
  plugin: 'Viene de un marketplace clonado. No conviene editarla: la próxima actualización la pisa. Copiala a las tuyas si querés cambiarla.',
  integrada: 'Viene dentro de Claude Code. No hay archivo en disco, así que no hay nada que editar.',
};

export default function SkillsPanel({ snap, flash }) {
  const [archivos, setArchivos] = useState(null);
  const [editando, setEditando] = useState(null);
  const [creando, setCreando] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [dir, setDir] = useState(false);       // buscador del directorio
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [ver, setVer] = useState(null);        // skill del directorio a instalar
  const [origen, setOrigen] = useState('');
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    try { setArchivos(await window.cockpit.skillsList()); }
    catch (e) { flash('No se pudieron leer las skills: ' + e.message, true); }
  }, [flash]);

  useEffect(() => { cargar(); }, [cargar]);

  // Cruza lo que hay en disco con el contador de uso que guarda Claude Code.
  // Las integradas solo existen en ese contador: no tienen archivo.
  const filas = useMemo(() => {
    const usoPorNombre = new Map((snap.config.skills || []).map((s) => [s.name, s]));
    const out = (archivos || []).map((a) => {
      const u = usoPorNombre.get(a.name);
      usoPorNombre.delete(a.name);
      return {
        ...a,
        usageCount: (u && u.usageCount) || 0,
        lastUsedAt: (u && u.lastUsedAt) || null,
      };
    });
    for (const u of usoPorNombre.values()) {
      out.push({
        name: u.name, description: null, scope: 'integrada', source: 'Claude Code',
        editable: false, dir: null, bytes: 0,
        usageCount: u.usageCount || 0, lastUsedAt: u.lastUsedAt || null,
      });
    }
    return out.sort((a, b) => (b.usageCount - a.usageCount) || a.name.localeCompare(b.name));
  }, [archivos, snap.config.skills]);

  const visibles = useMemo(() => filas.filter((f) => {
    if (origen && f.scope !== origen) return false;
    if (!filtro.trim()) return true;
    const q = filtro.toLowerCase();
    return f.name.toLowerCase().includes(q) || String(f.description || '').toLowerCase().includes(q);
  }), [filas, filtro, origen]);

  const correr = async (fn, msg) => {
    setBusy(true);
    try { await fn(); await cargar(); flash(msg); }
    catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  const conteos = useMemo(() => {
    const c = {};
    for (const f of filas) c[f.scope] = (c[f.scope] || 0) + 1;
    return c;
  }, [filas]);

  if (!archivos) return <div className="card dim">Cargando…</div>;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Skills ({filas.length})</h3>
          <input
            type="search" placeholder="filtrar…" value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            style={{ width: 180, fontSize: 11.5 }}
          />
          {['', 'usuario', 'proyecto', 'plugin', 'integrada'].map((o) => (
            <button
              key={o || 'todas'}
              className={'btn sm' + (origen === o ? ' primary' : '')}
              onClick={() => setOrigen(o)}
              title={AYUDA_ORIGEN[o] || 'Todas'}
            >
              {o || 'todas'}{o && conteos[o] ? ` (${conteos[o]})` : ''}
            </button>
          ))}
          <button className="btn sm right primary" onClick={() => setDir((v) => !v)}>
            {dir ? 'Cerrar directorio' : 'Buscar en skills.sh'}
          </button>
          <button
            className="btn sm"
            onClick={() => setCreando({ name: '', description: '', body: '' })}
          >
            Crear una skill
          </button>
        </div>

        {creando && (
          <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
            <b style={{ fontSize: 12.5 }}>Skill nueva</b>
            <div className="dim" style={{ fontSize: 11, margin: '4px 0 8px' }}>
              Se crea en ~/.claude/skills y queda disponible en todos tus proyectos.
            </div>
            <input
              type="text" placeholder="nombre-de-la-skill" value={creando.name}
              onChange={(e) => setCreando({ ...creando, name: e.target.value })}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <input
              type="text" placeholder="descripción: cuándo debe usarse (es lo que lee Claude para decidir)"
              value={creando.description}
              onChange={(e) => setCreando({ ...creando, description: e.target.value })}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <textarea
              placeholder="Instrucciones en markdown…" value={creando.body}
              onChange={(e) => setCreando({ ...creando, body: e.target.value })}
              style={{ width: '100%', minHeight: 120, fontFamily: 'inherit' }}
            />
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button
                className="btn sm primary" disabled={busy || !creando.name.trim()}
                onClick={() => correr(
                  () => window.cockpit.skillCreate(creando.name, creando.description, creando.body),
                  'Skill creada'
                ).then(() => setCreando(null))}
              >
                Crear
              </button>
              <button className="btn sm" onClick={() => setCreando(null)}>Cancelar</button>
            </div>
          </div>
        )}

        {dir && (
          <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
            <form
              className="row" style={{ gap: 6, marginBottom: 8 }}
              onSubmit={async (e) => {
                e.preventDefault();
                setBuscando(true);
                try { setRes(await window.cockpit.skillsSearch(q)); }
                catch (err) { flash('No se pudo buscar: ' + err.message, true); }
                finally { setBuscando(false); }
              }}
            >
              <input
                type="search" placeholder="postgres, react, testing, docx…"
                value={q} onChange={(e) => setQ(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn sm primary" type="submit" disabled={buscando}>
                {buscando ? '…' : 'Buscar'}
              </button>
            </form>

            <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', marginBottom: 8, fontSize: 11 }}>
              Una skill es texto que Claude va a leer y seguir como instrucciones. Cualquiera publica
              acá: mirá el contenido antes de instalarla.
            </div>

            {res && (
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {!res.skills.length && <div className="dim">Sin resultados.</div>}
                {res.skills.slice(0, 60).map((sk) => (
                  <div key={sk.id} className="row" style={{ gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <b style={{ fontSize: 12, minWidth: 210 }}>{sk.name}</b>
                    <span className="dim mono" style={{ fontSize: 10.5, flex: 1 }}>{sk.source}</span>
                    <span className="chip dim" style={{ fontSize: 10 }}>
                      {fmtInt(sk.installs)} inst.
                    </span>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        setVer({ sk, cargando: true });
                        try {
                          const d = await window.cockpit.skillsDetail(sk);
                          setVer(d ? { sk, ...d } : { sk, error: 'No encontré el SKILL.md en ese repositorio.' });
                        } catch (err) { setVer({ sk, error: err.message }); }
                      }}
                    >
                      Ver
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th>Origen</th>
              <th>Descripción</th>
              <th className="n">Usos</th>
              <th className="n">Último uso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((s) => (
              <tr key={s.scope + s.name + (s.dir || '')}>
                <td><b>{s.name}</b></td>
                <td>
                  <span className={'chip ' + (ORIGEN_CHIP[s.scope] || '')} style={{ fontSize: 10 }} title={AYUDA_ORIGEN[s.scope]}>
                    {s.scope}
                  </span>
                  {s.source && <div className="dim" style={{ fontSize: 10 }}>{s.source}</div>}
                </td>
                <td className="dim" style={{ maxWidth: 420, fontSize: 11.5 }}>
                  {s.description
                    ? <div className="trunc" title={s.description}>{s.description}</div>
                    : <span style={{ fontStyle: 'italic' }}>
                        {s.scope === 'integrada' ? 'vive dentro del binario' : 'sin descripción'}
                      </span>}
                </td>
                <td className="n">{s.usageCount || '—'}</td>
                <td className="n dim">{s.lastUsedAt ? fmtAgo(new Date(s.lastUsedAt).toISOString()) : '—'}</td>
                <td className="n">
                  {s.editable && (
                    <button className="btn sm" onClick={() => window.cockpit.skillRead(s.dir).then(setEditando)}>
                      Editar
                    </button>
                  )}
                  {s.scope === 'plugin' && (
                    <button
                      className="btn sm" disabled={busy}
                      title="Copiarla a ~/.claude/skills para poder editarla sin que la pise el marketplace"
                      onClick={() => correr(() => window.cockpit.skillFork(s.dir, s.name), 'Copiada a tus skills')}
                    >
                      Copiar a las mías
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editando && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ width: 820, maxWidth: '95vw', maxHeight: '92vh', overflow: 'auto' }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 14 }}>{editando.name}</b>
              <span className="chip dim" style={{ fontSize: 10 }}>{fmtBytes(editando.bytes)}</span>
              <button className="btn sm right" onClick={() => window.cockpit.revealPath(editando.file)}>
                Ver archivo
              </button>
            </div>

            <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 4 }}>
              DESCRIPCIÓN
            </div>
            <textarea
              value={editando.description}
              onChange={(e) => setEditando({ ...editando, description: e.target.value })}
              style={{ width: '100%', minHeight: 60, fontFamily: 'inherit', marginBottom: 4 }}
            />
            <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
              Es lo único que Claude lee para decidir si usar la skill. Conviene que diga
              <b> cuándo</b> usarla, no qué hace.
            </div>

            <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 4 }}>
              CONTENIDO
            </div>
            <textarea
              value={editando.body}
              onChange={(e) => setEditando({ ...editando, body: e.target.value })}
              style={{ width: '100%', minHeight: 320, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
            />

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button
                className="btn primary" disabled={busy}
                onClick={() => correr(
                  () => window.cockpit.skillSave(editando.dir, {
                    description: editando.description, body: editando.body,
                  }),
                  'Skill guardada'
                ).then(() => setEditando(null))}
              >
                Guardar
              </button>
              <button className="btn" onClick={() => setEditando(null)}>Cancelar</button>
              {String(editando.dir || '').includes('.claude') && !String(editando.dir).includes('marketplaces') && (
                <button
                  className="btn right" disabled={busy}
                  onClick={() => {
                    if (!window.confirm('¿Borrar la skill ' + editando.name + '? Se elimina la carpeta entera.')) return;
                    correr(() => window.cockpit.skillDelete(editando.dir), 'Skill borrada').then(() => setEditando(null));
                  }}
                >
                  Borrar
                </button>
              )}
            </div>
            <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
              Se guarda una copia del archivo anterior como <span className="mono">SKILL.md.bak</span> al lado.
            </div>
          </div>
        </div>
      )}

      {ver && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ width: 800, maxWidth: '95vw', maxHeight: '92vh', overflow: 'auto' }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <b style={{ fontSize: 14 }}>{ver.sk.name}</b>
              <span className="dim mono" style={{ fontSize: 11 }}>{ver.sk.source}</span>
              <span className="chip dim right" style={{ fontSize: 10 }}>{fmtInt(ver.sk.installs)} instalaciones</span>
            </div>

            {ver.cargando && <div className="empty"><span className="spin" /> trayendo el SKILL.md…</div>}
            {ver.error && <div className="chip bad" style={{ display: 'block', whiteSpace: 'normal' }}>{ver.error}</div>}

            {ver.raw && (
              <>
                {ver.description && (
                  <div className="block" style={{ marginBottom: 8 }}>{ver.description}</div>
                )}
                <div className="dim" style={{ fontSize: 10.5, marginBottom: 4 }}>
                  {ver.url}
                </div>
                <div className="block" style={{ maxHeight: 340, overflow: 'auto' }}>
                  <pre style={{ fontSize: 11 }}>{ver.raw}</pre>
                </div>
              </>
            )}

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              {ver.raw && (
                <button
                  className="btn primary" disabled={busy}
                  onClick={() => correr(
                    () => window.cockpit.skillsInstall(ver.sk.name, ver.raw),
                    'Skill instalada en ~/.claude/skills'
                  ).then(() => setVer(null))}
                >
                  Instalar en mis skills
                </button>
              )}
              <button className="btn" onClick={() => setVer(null)}>Cerrar</button>
              <span className="dim right" style={{ fontSize: 11 }}>
                Se copia el SKILL.md a ~/.claude/skills; después la podés editar
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Qué se puede editar y qué no.</b> Las tuyas y las del
        repositorio, sí. Las de un plugin no conviene: viven en un marketplace clonado y la próxima
        actualización te pisa el cambio — para eso está "copiar a las mías", que la trae a{' '}
        <span className="mono">~/.claude/skills</span> y ahí sí es tuya. Las integradas vienen dentro
        del binario de Claude Code y no tienen archivo que tocar.
      </div>
    </div>
  );
}
