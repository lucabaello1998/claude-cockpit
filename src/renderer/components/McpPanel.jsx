import React, { useCallback, useEffect, useState } from 'react';
import { basename } from '../util.js';

const VACIO = { name: '', type: 'stdio', command: '', args: '', url: '' };

function Definicion({ m }) {
  if (m.transport === 'conector') return <span className="dim">—</span>;
  return (
    <span className="mono dim trunc" style={{ fontSize: 11 }} title={m.command || ''}>
      {m.command}{m.args && m.args.length ? ' ' + m.args.join(' ') : ''}
    </span>
  );
}

export default function McpPanel({ snap, flash }) {
  const [nuevo, setNuevo] = useState(null);
  const [editando, setEditando] = useState(null);
  const [busy, setBusy] = useState(false);

  // buscador del registro oficial
  const [buscar, setBuscar] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [instalar, setInstalar] = useState(null);

  const servidores = snap.config.mcpServers || [];
  const propios = servidores.filter((m) => m.transport !== 'conector' && m.scope === 'usuario');
  const deProyecto = servidores.filter((m) => m.scope === 'proyecto');
  const conectores = servidores.filter((m) => m.transport === 'conector');

  const correr = async (fn, msg) => {
    setBusy(true);
    try { await fn(); flash(msg); }
    catch (e) { flash('No se pudo guardar: ' + e.message, true); }
    finally { setBusy(false); }
  };

  const guardar = (form) => {
    const def = {
      type: form.type,
      command: form.type === 'stdio' ? form.command.trim() : '',
      url: form.type === 'stdio' ? '' : form.url.trim(),
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env: form.env || undefined,
    };
    return correr(
      () => window.cockpit.mcpSetUser(form.name.trim(), def),
      'Servidor guardado'
    ).then(() => { setNuevo(null); setEditando(null); setInstalar(null); });
  };

  const hacerBusqueda = useCallback(async (texto) => {
    setBuscando(true);
    try { setRes(await window.cockpit.mcpSearchRegistry(texto)); }
    catch (e) { flash('No se pudo buscar: ' + e.message, true); }
    finally { setBuscando(false); }
  }, [flash]);

  useEffect(() => { if (buscar && !res) hacerBusqueda(''); }, [buscar, res, hacerBusqueda]);

  const Form = ({ form, setForm, onCancel, titulo }) => (
    <div className="card" style={{ background: 'var(--panel-2)', marginTop: 10 }}>
      <b style={{ fontSize: 12.5 }}>{titulo}</b>
      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
        <input
          type="text" placeholder="nombre" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          style={{ width: 160, fontSize: 11.5 }}
        />
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={{ fontSize: 11.5 }}>
          <option value="stdio">stdio (programa local)</option>
          <option value="http">http (servidor remoto)</option>
          <option value="sse">sse (servidor remoto)</option>
        </select>
        {form.type === 'stdio' ? (
          <>
            <input
              type="text" placeholder="comando (npx, docker, ruta al .exe)" value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              style={{ width: 220, fontSize: 11.5 }}
            />
            <input
              type="text" placeholder="argumentos separados por espacio" value={form.args}
              onChange={(e) => setForm({ ...form, args: e.target.value })}
              style={{ flex: 1, minWidth: 200, fontSize: 11.5 }}
            />
          </>
        ) : (
          <input
            type="text" placeholder="https://..." value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            style={{ flex: 1, minWidth: 240, fontSize: 11.5 }}
          />
        )}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          className="btn sm primary"
          disabled={busy || !form.name.trim() || (form.type === 'stdio' ? !form.command.trim() : !form.url.trim())}
          onClick={() => guardar(form)}
        >
          Guardar
        </button>
        <button className="btn sm" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Tus servidores ({propios.length})</h3>
          <div className="right row" style={{ gap: 6 }}>
            <button className="btn sm primary" onClick={() => setBuscar((v) => !v)}>
              {buscar ? 'Cerrar buscador' : 'Buscar en el registro oficial'}
            </button>
            <button className="btn sm" onClick={() => { setNuevo({ ...VACIO }); setEditando(null); }}>
              Agregar a mano
            </button>
          </div>
        </div>

        {!propios.length && !nuevo && (
          <div className="dim" style={{ fontSize: 12 }}>Todavía no configuraste ninguno.</div>
        )}

        {propios.map((m) => (
          <div key={m.name} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row" style={{ gap: 8 }}>
              <b style={{ fontSize: 12.5, minWidth: 150 }}>{m.name}</b>
              <span className="chip" style={{ fontSize: 10 }}>{m.transport}</span>
              <Definicion m={m} />
              <button
                className="btn sm"
                onClick={() => {
                  setNuevo(null);
                  setEditando({
                    name: m.name, type: m.transport === 'stdio' ? 'stdio' : m.transport,
                    command: m.transport === 'stdio' ? (m.command || '') : '',
                    url: m.transport === 'stdio' ? '' : (m.command || ''),
                    args: (m.args || []).join(' '),
                  });
                }}
              >
                Editar
              </button>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => correr(() => window.cockpit.mcpRemoveUser(m.name), 'Servidor quitado')}
              >
                Quitar
              </button>
            </div>
            {editando && editando.name === m.name && (
              <Form form={editando} setForm={setEditando} onCancel={() => setEditando(null)} titulo={'Editar ' + m.name} />
            )}
          </div>
        ))}

        {nuevo && <Form form={nuevo} setForm={setNuevo} onCancel={() => setNuevo(null)} titulo="Servidor nuevo" />}
      </div>

      {buscar && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Registro oficial de MCP</h3>
            {buscando && <span className="spin" />}
          </div>

          <form
            className="row" style={{ gap: 6, marginBottom: 10 }}
            onSubmit={(e) => { e.preventDefault(); hacerBusqueda(q); }}
          >
            <input
              type="search" placeholder="filesystem, github, postgres, slack…"
              value={q} onChange={(e) => setQ(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn sm primary" type="submit" disabled={buscando}>Buscar</button>
          </form>

          <div className="chip warn" style={{ display: 'block', whiteSpace: 'normal', marginBottom: 10, fontSize: 11 }}>
            Esto no es una tienda curada: cualquiera publica acá. Instalar un servidor significa
            correr código de un tercero en tu máquina, con acceso a lo que Claude Code pueda hacer.
            Mirá quién lo publica antes de agregarlo.
          </div>

          {res && (
            <div style={{ maxHeight: 380, overflow: 'auto' }}>
              {!res.servers.length && <div className="dim">Sin resultados.</div>}
              {res.servers.map((s) => {
                const paq = s.packages[0];
                const rem = s.remotes[0];
                const yaEsta = propios.some((m) => m.name === basename(s.name));
                return (
                  <div key={s.name} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b style={{ fontSize: 12.5 }}>{s.title}</b>
                      {s.version && <span className="chip dim" style={{ fontSize: 10 }}>v{s.version}</span>}
                      {paq && <span className="chip info" style={{ fontSize: 10 }}>{paq.registryType}</span>}
                      {rem && !paq && <span className="chip alt" style={{ fontSize: 10 }}>remoto</span>}
                      {yaEsta && <span className="chip on" style={{ fontSize: 10 }}>ya lo tenés</span>}
                      <button
                        className="btn sm right"
                        disabled={busy || (!paq && !rem)}
                        onClick={() => setInstalar({ s, paq, rem, env: {} })}
                      >
                        Ver e instalar
                      </button>
                    </div>
                    <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>{s.description}</div>
                    <div className="dim mono" style={{ fontSize: 10.5, marginTop: 2 }}>{s.name}</div>
                  </div>
                );
              })}
              {res.nextCursor && (
                <div className="dim" style={{ fontSize: 11, padding: '8px 0' }}>
                  Hay más resultados: afiná la búsqueda.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {deProyecto.length > 0 && (
        <div className="card">
          <h3>Definidos en un proyecto ({deProyecto.length})</h3>
          {deProyecto.map((m, i) => (
            <div key={m.name + i} className="row" style={{ gap: 8, padding: '5px 0' }}>
              <b style={{ fontSize: 12.5, minWidth: 150 }}>{m.name}</b>
              <span className="chip" style={{ fontSize: 10 }}>{basename(m.project)}</span>
              <Definicion m={m} />
            </div>
          ))}
          <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
            Estos se editan desde <b>Proyectos</b>, en la ficha de cada carpeta.
          </div>
        </div>
      )}

      {conectores.length > 0 && (
        <div className="card">
          <h3>Conectores de claude.ai ({conectores.length})</h3>
          <div className="row wrap" style={{ gap: 5 }}>
            {conectores.map((m) => (
              <span key={m.name} className={'chip ' + (m.needsAuth ? 'warn' : 'on')} style={{ fontSize: 10.5 }}>
                {m.name}
              </span>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
            No se editan desde acá: su definición vive en tu cuenta y cada persona autoriza la suya
            desde la configuración de conectores en claude.ai.
          </div>
        </div>
      )}

      {instalar && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <div className="card" style={{ maxWidth: 620, maxHeight: '90vh', overflow: 'auto' }}>
            <b style={{ fontSize: 14 }}>{instalar.s.title}</b>
            <div className="dim" style={{ fontSize: 11.5, margin: '6px 0 12px' }}>{instalar.s.description}</div>

            <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5 }}>SE VA A ESCRIBIR ESTO</div>
            <div className="block mono" style={{ fontSize: 11.5, marginTop: 4 }}>
              {instalar.paq
                ? `"${basename(instalar.s.name)}": { "command": "${instalar.paq.command}", "args": [${instalar.paq.args.map((a) => `"${a}"`).join(', ')}] }`
                : `"${basename(instalar.s.name)}": { "type": "${instalar.rem.type.replace('streamable-', '')}", "url": "${instalar.rem.url}" }`}
            </div>

            {instalar.paq && instalar.paq.env.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 4 }}>
                  VARIABLES QUE PIDE
                </div>
                {instalar.paq.env.map((v) => (
                  <div key={v.name} className="row" style={{ gap: 8, padding: '3px 0' }}>
                    <span className="mono" style={{ fontSize: 11, minWidth: 190 }}>
                      {v.name}{v.required && <span style={{ color: 'var(--yellow)' }}> *</span>}
                    </span>
                    <input
                      type="text"
                      placeholder={v.secret ? 'dejalo vacío y ponelo como variable del sistema' : (v.default || v.description.slice(0, 40))}
                      value={instalar.env[v.name] || ''}
                      onChange={(e) => setInstalar({ ...instalar, env: { ...instalar.env, [v.name]: e.target.value } })}
                      style={{ flex: 1, fontSize: 11.5 }}
                    />
                  </div>
                ))}
                {instalar.paq.env.some((v) => v.secret) && (
                  <div className="chip bad" style={{ display: 'block', whiteSpace: 'normal', marginTop: 8, fontSize: 11 }}>
                    Hay variables marcadas como secretas. Lo que escribas acá queda en texto plano en
                    ~/.claude.json. Si es una credencial, mejor dejala vacía y definila como variable
                    de entorno del sistema.
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  const nombre = basename(instalar.s.name);
                  const env = {};
                  for (const [k, v] of Object.entries(instalar.env)) if (String(v).trim()) env[k] = v;
                  guardar({
                    name: nombre,
                    type: instalar.paq ? 'stdio' : instalar.rem.type.replace('streamable-', ''),
                    command: instalar.paq ? instalar.paq.command : '',
                    url: instalar.paq ? '' : instalar.rem.url,
                    args: instalar.paq ? instalar.paq.args.join(' ') : '',
                    env: Object.keys(env).length ? env : undefined,
                  });
                }}
              >
                Agregar a mi configuración
              </button>
              <button className="btn" onClick={() => setInstalar(null)}>Cancelar</button>
              <span className="dim right" style={{ fontSize: 11 }}>Reiniciá Claude Code después</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
