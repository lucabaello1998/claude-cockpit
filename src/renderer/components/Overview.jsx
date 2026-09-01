import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import {
  fmtInt, fmtTokens, fmtUSD, fmtBytes, fmtAgo, fmtUntil, meterColor, basename, modelColor,
} from '../util.js';
import { esCreditsReason } from '../i18n.js';
import { useMoney } from '../money.js';

function Stat({ label, value, sub, hint }) {
  return (
    <div className="card stat" title={hint || undefined}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// El valor de ~/.claude.json solo se refresca cuando Claude Code hace un
// request, asi que se queda viejo. Este panel puede pedir el dato en vivo
// al mismo endpoint que usa /usage, pero solo cuando vos lo pedis.
function UsageMeters({ cached }) {
  const [live, setLive] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(() => {
    try { return localStorage.getItem('cockpit.autoUsage') === '1'; } catch { return false; }
  });

  // `silent` es el refresco automatico; solo el click del usuario fuerza la
  // consulta. El resto se conforma con la respuesta cacheada del main, que es
  // lo que evita el 429 cuando hay varias fuentes pidiendo a la vez.
  const pull = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      setLive(await window.cockpit.liveUsage(!silent));
      setErr(null);
    } catch (e) {
      setErr(String(e.message || e).split('\n')[0].replace(/^Error:\s*/, ''));
    } finally {
      setLoading(false);
    }
  }, []);

  // Una consulta al abrir la app: si no, arranca mostrando el valor cacheado
  // de ~/.claude.json, que casi siempre esta atrasado.
  useEffect(() => { pull(true); }, [pull]);

  useEffect(() => {
    try { localStorage.setItem('cockpit.autoUsage', auto ? '1' : '0'); } catch { /* modo privado */ }
    if (!auto) return;
    const id = setInterval(() => pull(true), 120000);
    return () => clearInterval(id);
  }, [auto, pull]);

  const shown = live || cached;
  const meters = shown ? shown.meters : [];
  const isLive = !!live;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Límites de uso</h3>
        <span className={'chip ' + (isLive ? 'on' : '')}>
          {isLive ? 'en vivo' : 'caché de Claude Code'}
          {shown && shown.fetchedAtMs ? ' · ' + fmtAgo(new Date(shown.fetchedAtMs).toISOString()) : ''}
        </span>
        <div className="right row" style={{ gap: 6 }}>
          <label className="chip" style={{ cursor: 'pointer' }} title="Consultar cada 2 minutos mientras la app esté abierta">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ margin: 0 }} />
            auto
          </label>
          <button
            className="btn sm primary"
            title="Consulta la API de Anthropic con tu sesion de Claude Code. No escribe nada ni guarda el token."
            onClick={() => pull(false)}
            disabled={loading}
          >
            {loading ? 'consultando…' : 'Actualizar uso'}
          </button>
        </div>
      </div>

      {err && (
        <div className="chip bad" style={{ marginBottom: 10, whiteSpace: 'normal', display: 'block' }}>
          {err}
        </div>
      )}

      {!meters.length ? (
        <div className="dim">
          Sin datos todavía. Apretá <b>Actualizar uso</b>, o abrí Claude Code una vez para que
          escriba el valor cacheado en ~/.claude.json.
        </div>
      ) : (
        meters
          .filter((m) => m.utilization > 0 || m.key === 'five_hour' || m.key === 'seven_day')
          .map((m) => (
            <div className="meter" key={m.key}>
              <div className="meter-head">
                <span>
                  {m.label}
                  {m.isActive && (
                    <span
                      className="chip warn"
                      style={{ marginLeft: 7, fontSize: 10 }}
                      title="De todos tus limites, este es el que se agota primero: es el que en la practica te corta"
                    >
                      es el que te frena
                    </span>
                  )}
                </span>
                <span className="num">
                  <b style={{ color: meterColor(m.utilization) }}>{m.utilization}%</b>
                  <span className="dim"> · reinicia {fmtUntil(m.resetsAt)}</span>
                </span>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, m.utilization)}%`, background: meterColor(m.utilization) }}
                />
              </div>
            </div>
          ))
      )}

      {live && live.extraUsage && (
        <div className="dim" style={{ fontSize: 11.5, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
          Créditos de uso extra:{' '}
          <b style={{ color: live.extraUsage.enabled ? 'var(--green)' : 'var(--muted)' }}>
            {live.extraUsage.enabled ? 'activos' : 'sin créditos'}
          </b>
          {!live.extraUsage.enabled && live.extraUsage.disabledReason
            && ` (${esCreditsReason(live.extraUsage.disabledReason)})`}
          {live.extraUsage.utilization != null && ` · ${live.extraUsage.utilization}% usado`}
          {' — '}sin créditos, al llegar al 100% de un medidor el trabajo se corta hasta que reinicie.
        </div>
      )}

      {!isLive && (
        <div className="dim" style={{ fontSize: 11, marginTop: 10 }}>
          El valor cacheado solo se actualiza cuando Claude Code hace un request, por eso puede
          quedar atrás. "Actualizar uso" consulta la API con tu sesión OAuth y no escribe nada.
        </div>
      )}
    </div>
  );
}

const PERIODS = [
  { key: 'today', label: 'Hoy' },
  { key: 'h24', label: '24 h' },
  { key: 'd7', label: '7 dias' },
  { key: 'd30', label: '30 dias' },
  { key: 'all', label: 'Todo' },
];

// Etiqueta del eje X: los periodos cortos vienen por hora (2026-08-29T10),
// los largos por dia (2026-08-29).
function axisLabel(key) {
  return key.includes('T') ? key.slice(11) + 'h' : key.slice(5);
}

export default function Overview({ snap, memory, onGoto }) {
  const [periodKey, setPeriodKey] = useState(() => {
    try { return localStorage.getItem('cockpit.period') || 'd7'; } catch { return 'd7'; }
  });
  useEffect(() => {
    try { localStorage.setItem('cockpit.period', periodKey); } catch { /* modo privado */ }
  }, [periodKey]);

  const machines = snap.machines || [];
  const [machineId, setMachineId] = useState('');
  // Si la maquina elegida deja de estar (se desvinculo la carpeta), volvemos al total.
  const activeMachine = machineId && machines.some((m) => m.id === machineId) ? machineId : '';

  const limits = snap.config.usageLimits;
  const periods = (activeMachine && snap.periodsByMachine && snap.periodsByMachine[activeMachine])
    || snap.periods || {};
  const p = periods[periodKey] || periods.all;
  const topMemory = memory
    ? memory.providers.flatMap((pr) => pr.stores.map((st) => ({ ...st, provider: pr.label })))
    : [];

  // useMoney() va antes de cualquier return: si se llama despues, el primer
  // render sin datos ejecuta menos hooks que el siguiente y React tira
  // "Rendered fewer hooks than expected" (pantalla en negro).
  const money = useMoney();
  // La serie viene con los tokens separados; el grafico necesita el total.
  const serie = useMemo(
    () => (p ? p.series.map((d) => ({
      ...d, tokens: d.input + d.output + d.cacheRead + d.cacheWrite,
    })) : []),
    [p]
  );

  if (!p) return <div className="empty">Sin datos todavía.</div>;

  const t = p.totals;
  // Sin tabla de precios no se grafican dolares: todo pasa a tokens, incluido
  // el largo de las barras (antes mostraban tokens pero median plata).
  const clave = money.show ? 'costUSD' : 'tokens';
  // byProject trae totalTokens; byModel no, trae los sumandos sueltos.
  const tokensDe = (f) => (f.totalTokens != null
    ? f.totalTokens
    : (f.input || 0) + (f.output || 0) + (f.cacheRead || 0) + (f.cacheWrite || 0));
  const barra = (f) => (money.show ? (f.costUSD || 0) : tokensDe(f)) || 0;

  // El backend ordena SIEMPRE por costo. En modo tokens eso deja de coincidir
  // con lo que se dibuja: tomar el elemento [0] como maximo daba barras de
  // 7500% que el overflow recortaba a 100%, todas iguales, al lado de numeros
  // muy distintos. Se reordena y se mide con la metrica que se esta mostrando.
  const filasProyecto = [...p.byProject].sort((a, b) => barra(b) - barra(a)).slice(0, 7);
  const maxProyecto = Math.max(1, ...filasProyecto.map(barra));
  const filasModelo = p.byModel.filter((m) => barra(m) > 0).sort((a, b) => barra(b) - barra(a));
  const maxModelo = Math.max(1, ...filasModelo.map(barra));
  const cachePct = Math.round((t.cacheRead / Math.max(1, t.totalTokens)) * 100);
  const periodLabel = PERIODS.find((x) => x.key === periodKey).label;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <UsageMeters cached={limits} />

      <div className="row" style={{ gap: 6 }}>
        <span className="dim" style={{ fontSize: 11.5 }}>Periodo</span>
        {PERIODS.map((x) => (
          <button
            key={x.key}
            className={'btn sm' + (periodKey === x.key ? ' primary' : '')}
            onClick={() => setPeriodKey(x.key)}
          >
            {x.label}
          </button>
        ))}
        {machines.length > 1 && (
          <>
            <span className="dim" style={{ fontSize: 11.5, marginLeft: 10 }}>Maquina</span>
            <select value={activeMachine} onChange={(e) => setMachineId(e.target.value)} style={{ fontSize: 11.5 }}>
              <option value="">Todas ({machines.length})</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.label}{m.isLocal ? ' (esta)' : ''}</option>
              ))}
            </select>
          </>
        )}
        <span className="right chip dim">
          {p.sessions} {p.sessions === 1 ? 'sesion' : 'sesiones'} · {fmtInt(p.userTurns)} prompts tuyos
        </span>
      </div>

      <div className="grid g4">
        <Stat
          label={(money.show ? 'Costo · ' : 'Tokens · ') + periodLabel}
          value={money.valor(t.costUSD, t.totalTokens)}
          sub={`${fmtInt(t.requests)} requests · ${money.unidad}`}
          hint={money.show
            ? 'Estimado a tarifa API pública. Tu cuenta es por suscripción: sirve para comparar, no es una factura.'
            : 'Tokens facturados: input + salida + caché leída + caché escrita. Salen del transcript, son exactos.'}
        />
        <Stat
          label="Por consulta tuya"
          value={p.userTurns
            ? money.valor(t.costUSD / p.userTurns, Math.round(t.totalTokens / p.userTurns))
            : '—'}
          sub={`${fmtInt(p.userTurns)} prompts en el período${money.aprox}`}
          hint="Total del período dividido por la cantidad de mensajes que escribiste vos."
        />
        <Stat
          label="Tokens facturados"
          value={fmtTokens(t.totalTokens)}
          sub={`${fmtTokens(t.cacheRead)} de cache releida (${cachePct}%)`}
          hint="No son tokens distintos: la cache releida es el mismo contexto contado de nuevo en cada request."
        />
        <Stat
          label="Salida generada"
          value={fmtTokens(t.output)}
          sub={`${fmtTokens(t.thinking)} de razonamiento`}
          hint="Lo unico realmente nuevo que produjo el modelo en el periodo."
        />
      </div>

      <div className="card">
        <h3>
          {money.show ? 'Costo equivalente (aprox.)' : 'Tokens facturados'} · {periodLabel}
          <span className="dim" style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
            {p.granularity === 'hour' ? 'por hora' : 'por dia'}
          </span>
        </h3>
        <div style={{ height: 190 }}>
          <ResponsiveContainer>
            <AreaChart data={serie} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="ovGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#d97757" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#d97757" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#2c2c29" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#6b675f', fontSize: 10 }} tickLine={false} axisLine={false}
                tickFormatter={axisLabel} minTickGap={14} />
              <YAxis tick={{ fill: '#6b675f', fontSize: 10 }} tickLine={false} axisLine={false}
                tickFormatter={(v) => (money.show ? fmtUSD(v) : fmtTokens(v))} />
              <Tooltip
                contentStyle={{ background: '#1f1f1d', border: '1px solid #2c2c29', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#918c81' }}
                labelFormatter={(k) => (String(k).includes('T') ? String(k).replace('T', ' ') + ':00' : k)}
                formatter={(v, n, item) => [
                  `${money.show ? fmtUSD(v) : fmtTokens(v)} · ${item.payload.requests} requests`,
                  money.show ? 'equivalente API' : 'tokens facturados',
                ]}
              />
              <Area type="monotone" dataKey={clave} stroke="#d97757" strokeWidth={2} fill="url(#ovGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          {money.show ? snap.pricingNote : 'Los tokens salen del transcript: son exactos y no dependen de ninguna tabla de precios.'}
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>Proyectos · {periodLabel}{money.aprox}</h3>
          {!filasProyecto.length ? <div className="dim">Sin actividad en el periodo.</div> :
            filasProyecto.map((pr) => (
              <div className="bar-row" key={pr.key}>
                <span className="name trunc" title={pr.project}>{basename(pr.project)}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${(barra(pr) / maxProyecto) * 100}%` }} />
                </span>
                <span className="val">{money.valor(pr.costUSD, pr.totalTokens)}</span>
              </div>
            ))}
        </div>

        <div className="card">
          <h3>Modelos · {periodLabel}{money.aprox}</h3>
          {!filasModelo.length ? <div className="dim">Sin actividad en el periodo.</div> :
            filasModelo.map((m, i) => (
              <div className="bar-row" key={m.key}>
                <span className="name trunc" title={m.key}>{m.label}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${(barra(m) / maxModelo) * 100}%`, background: modelColor(m.label, i) }} />
                </span>
                <span className="val">{money.show ? fmtUSD(m.costUSD) : fmtTokens(tokensDe(m))}</span>
              </div>
            ))}
          <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
            Configurado ahora: <b>{snap.config.settings.model || 'default'}</b>
            {snap.config.settings.effortLevel && ` · effort ${snap.config.settings.effortLevel}`}
          </div>
        </div>
      </div>

      <div className="grid g3">
        <div className="card">
          <h3>Herramientas más usadas</h3>
          {snap.byTool.slice(0, 8).map((tool) => {
            const max = snap.byTool[0].count || 1;
            return (
              <div className="bar-row" key={tool.name}>
                <span className="name trunc">{tool.name}</span>
                <span className="track"><span className="fill" style={{ width: `${(tool.count / max) * 100}%`, background: 'var(--blue)' }} /></span>
                <span className="val">{fmtInt(tool.count)}</span>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3>Instalado</h3>
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            {snap.config.mcpServers.map((m) => (
              <span key={m.name + m.scope} className={'chip ' + (m.needsAuth ? 'warn' : 'on')} title={m.command || ''}>
                {m.name}
              </span>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.9 }}>
            {snap.config.skills.length} skills · {snap.config.workflows.length} workflows ·{' '}
            {snap.config.settings.hooks.length} hooks<br />
            {snap.config.plugins.marketplaces.reduce((a, m) => a + m.pluginCount, 0)} plugins disponibles
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => onGoto('config')}>Ver todo</button>
        </div>

        <div className="card">
          <h3>Grafos de código</h3>
          {!topMemory.length ? (
            <div className="dim">Ningún repo indexado todavía.</div>
          ) : (
            topMemory.map((s) => (
              <div key={s.dir} style={{ marginBottom: 10 }}>
                <div className="row">
                  <b style={{ fontSize: 12.5 }}>{s.name}</b>
                  <span className={'chip ' + (s.stale ? 'warn' : 'on')}>{s.stale ? 'desactualizado' : 'al día'}</span>
                </div>
                <div className="dim" style={{ fontSize: 11 }}>
                  {s.provider} · {fmtInt(s.nodes)} nodos · {fmtInt(s.edges)} edges · {fmtBytes(s.compressedBytes)}
                </div>
              </div>
            ))
          )}
          <button className="btn sm" style={{ marginTop: 4 }} onClick={() => onGoto('memory')}>Ver memorias</button>
        </div>
      </div>
    </div>
  );
}
