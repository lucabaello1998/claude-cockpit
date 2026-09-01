import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtAgo, fmtInt } from '../util.js';

export default function PluginsPanel({ flash }) {
  const [datos, setDatos] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [soloHabilitados, setSoloHabilitados] = useState(false);
  const [nuevoRepo, setNuevoRepo] = useState('');
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    try { setDatos(await window.cockpit.pluginsList()); }
    catch (e) { flash('No se pudieron leer los plugins: ' + e.message, true); }
  }, [flash]);

  useEffect(() => { cargar(); }, [cargar]);

  const correr = async (fn, msg) => {
    setBusy(true);
    try { await fn(); await cargar(); flash(msg); }
    catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  };

  const todos = useMemo(
    () => (datos ? datos.marketplaces.flatMap((m) => m.plugins.map((p) => ({ ...p, marketplace: m.name }))) : []),
    [datos]
  );

  const categorias = useMemo(() => {
    const c = {};
    for (const p of todos) c[p.category || 'sin categoría'] = (c[p.category || 'sin categoría'] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [todos]);

  const visibles = useMemo(() => todos.filter((p) => {
    if (soloHabilitados && !p.enabled) return false;
    if (cat && (p.category || 'sin categoría') !== cat) return false;
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return p.name.toLowerCase().includes(s)
      || p.displayName.toLowerCase().includes(s)
      || p.description.toLowerCase().includes(s)
      || (p.keywords || []).some((k) => String(k).toLowerCase().includes(s));
  }), [todos, q, cat, soloHabilitados]);

  if (!datos) return <div className="card dim">Cargando…</div>;

  const habilitados = todos.filter((p) => p.enabled);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Estado</h3>
          <span className={'chip ' + (habilitados.length ? 'on' : 'warn')}>
            {habilitados.length} de {todos.length} habilitados
          </span>
        </div>
        {!habilitados.length ? (
          <div className="dim" style={{ fontSize: 12, lineHeight: 1.7 }}>
            Tenés el marketplace clonado, pero <b>ningún plugin habilitado</b>. Que los archivos
            estén en el disco no alcanza: Claude Code decide con la clave{' '}
            <span className="mono">enabledPlugins</span> de{' '}
            <span className="mono">settings.json</span>, y hoy no existe. O sea que sus skills y
            comandos no están disponibles.
          </div>
        ) : (
          <div className="row wrap" style={{ gap: 5 }}>
            {habilitados.map((p) => (
              <span key={p.id} className="chip on" style={{ fontSize: 10.5 }}>{p.displayName}</span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <input
            type="search" placeholder="buscar por nombre, descripción o palabra clave…"
            value={q} onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ fontSize: 11.5 }}>
            <option value="">Todas las categorías</option>
            {categorias.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
          </select>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox" checked={soloHabilitados}
              onChange={(e) => setSoloHabilitados(e.target.checked)} style={{ margin: 0 }}
            />
            solo habilitados
          </label>
          <span className="dim" style={{ fontSize: 11 }}>{visibles.length}</span>
        </div>

        <div style={{ maxHeight: 460, overflow: 'auto' }}>
          {visibles.slice(0, 120).map((p) => (
            <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div className="row" style={{ gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>{p.displayName}</b>
                {p.category && <span className="chip" style={{ fontSize: 10 }}>{p.category}</span>}
                {p.version && <span className="chip dim" style={{ fontSize: 10 }}>v{p.version}</span>}
                {p.descargado
                  ? <span className="chip info" style={{ fontSize: 10 }} title="Sus archivos ya están en el disco">descargado</span>
                  : <span className="chip dim" style={{ fontSize: 10 }} title="Se baja recién al habilitarlo">se baja al habilitar</span>}
                <button
                  className={'btn sm right' + (p.enabled ? '' : ' primary')}
                  disabled={busy}
                  onClick={() => correr(
                    () => window.cockpit.pluginSetEnabled(p.id, !p.enabled),
                    p.enabled ? 'Plugin deshabilitado' : 'Plugin habilitado'
                  )}
                >
                  {p.enabled ? 'Deshabilitar' : 'Habilitar'}
                </button>
              </div>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>{p.description}</div>
              <div className="row" style={{ gap: 8, marginTop: 3 }}>
                <span className="dim mono" style={{ fontSize: 10 }}>{p.id}</span>
                {p.author && <span className="dim" style={{ fontSize: 10 }}>· {p.author}</span>}
                {p.homepage && (
                  <span
                    className="dim" style={{ fontSize: 10, cursor: 'pointer', color: 'var(--blue)' }}
                    onClick={() => window.cockpit.openExternal(p.homepage)}
                  >
                    · sitio
                  </span>
                )}
              </div>
            </div>
          ))}
          {visibles.length > 120 && (
            <div className="dim" style={{ fontSize: 11, padding: '8px 0' }}>
              Mostrando 120 de {visibles.length}: afiná la búsqueda.
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Marketplaces ({datos.marketplaces.length})</h3>
        {datos.marketplaces.map((m) => (
          <div key={m.name} className="row" style={{ gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <b style={{ fontSize: 12.5, minWidth: 190 }}>{m.name}</b>
            <span className="chip" style={{ fontSize: 10 }}>{fmtInt(m.total)} plugins</span>
            {m.repo && <span className="dim mono" style={{ fontSize: 10.5 }}>{m.repo}</span>}
            <span className="dim" style={{ fontSize: 10.5 }}>{m.lastUpdated ? fmtAgo(m.lastUpdated) : ''}</span>
            <div className="right row" style={{ gap: 6 }}>
              <button
                className="btn sm" disabled={busy}
                onClick={() => correr(() => window.cockpit.marketplaceUpdate(m.name), 'Marketplace actualizado')}
              >
                Actualizar
              </button>
              <button
                className="btn sm" disabled={busy}
                onClick={() => {
                  if (!window.confirm('¿Quitar el marketplace ' + m.name + '? Se borra la copia local y se deshabilitan sus plugins.')) return;
                  correr(() => window.cockpit.marketplaceRemove(m.name), 'Marketplace quitado');
                }}
              >
                Quitar
              </button>
            </div>
          </div>
        ))}

        <div className="row" style={{ gap: 6, marginTop: 12 }}>
          <input
            type="text" placeholder="usuario/repo o URL de git"
            value={nuevoRepo} onChange={(e) => setNuevoRepo(e.target.value)}
            style={{ flex: 1, fontSize: 11.5 }}
          />
          <button
            className="btn sm primary" disabled={busy || !nuevoRepo.trim()}
            onClick={() => correr(
              () => window.cockpit.marketplaceAdd(nuevoRepo.trim()),
              'Marketplace agregado'
            ).then(() => setNuevoRepo(''))}
          >
            Agregar marketplace
          </button>
        </div>
        <div className="dim" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
          Un marketplace es un repositorio git con un{' '}
          <span className="mono">.claude-plugin/marketplace.json</span>. Se clona y se valida antes
          de registrarlo: si el repo no tiene ese archivo, no se agrega nada.{' '}
          <span
            style={{ cursor: 'pointer', color: 'var(--blue)' }}
            onClick={() => window.cockpit.openExternal('https://github.com/anthropics/skills')}
          >
            anthropics/skills
          </span>{' '}
          es el repositorio oficial de Agent Skills y funciona como marketplace.
        </div>
      </div>

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Habilitar un plugin es ejecutar código de terceros.</b> Sus
        skills, comandos, hooks y servidores MCP pasan a estar activos en tus sesiones. De los{' '}
        {fmtInt(todos.length)} del catálogo, solo {fmtInt(todos.filter((p) => p.descargado).length)}{' '}
        están descargados; el resto se baja de su propio repositorio recién cuando lo habilitás.
        Mirá el autor antes.
        <br /><br />
        Los cambios se escriben en <span className="mono">{datos.settingsFile}</span>. Reiniciá Claude
        Code para que los tome.
      </div>
    </div>
  );
}
