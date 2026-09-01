import React, { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { fmtInt, fmtTokens, fmtUSD, fmtDate, basename, modelColor } from '../util.js';
import { useMoney } from '../money.js';

// Los rangos apuntan a los periodos que ya calcula el proceso principal, asi
// que todo el panel (tarjetas, grafico y tablas) sale de la misma fuente y
// no puede desincronizarse.
const RANGES = [
  { key: 'd7', label: '7 días' },
  { key: 'd14', label: '14 días' },
  { key: 'd30', label: '30 días' },
  { key: 'all', label: 'Todo' },
];

const METRICS = [
  { id: 'costUSD', label: 'Costo equivalente', fmt: fmtUSD },
  { id: 'tokens', label: 'Tokens facturados', fmt: fmtTokens },
  { id: 'requests', label: 'Requests', fmt: fmtInt },
];

export default function Tokens({ snap }) {
  const [rangeKey, setRangeKey] = useState('d14');
  const [metric, setMetric] = useState('costUSD');
  const [sortBy, setSortBy] = useState('costUSD');

  const periods = snap.periods || {};
  const p = periods[rangeKey] || periods.all;

  const series = useMemo(
    () => (p ? p.series.map((d) => ({
      ...d,
      tokens: d.input + d.output + d.cacheRead + d.cacheWrite,
    })) : []),
    [p]
  );

  const modelLabels = useMemo(
    () => (p ? p.byModel.filter((m) => m.costUSD > 0).map((m) => m.label) : []),
    [p]
  );

  const stacked = useMemo(
    () => series.map((d) => {
      const row = { date: d.date, requests: d.requests };
      for (const label of modelLabels) row[label] = d.models[label] || 0;
      return row;
    }),
    [series, modelLabels]
  );

  // La tabla de sesiones se queda como estaba: siempre todas, ordenables.
  const sessions = useMemo(() => {
    const rows = [...snap.sessions];
    rows.sort((a, b) => {
      if (sortBy === 'costUSD') return b.totals.costUSD - a.totals.costUSD;
      if (sortBy === 'tokens') return b.totals.totalTokens - a.totals.totalTokens;
      if (sortBy === 'perTurn') {
        const av = a.userTurns ? a.totals.costUSD / a.userTurns : 0;
        const bv = b.userTurns ? b.totals.costUSD / b.userTurns : 0;
        return bv - av;
      }
      return String(b.endedAt || '').localeCompare(String(a.endedAt || ''));
    });
    return rows;
  }, [snap.sessions, sortBy]);

  // useMoney() no puede quedar despues del return temprano: el render sin
  // datos ejecutaria menos hooks que el siguiente y React aborta el arbol.
  const money = useMoney();

  if (!p) return <div className="empty">Sin datos todavía.</div>;

  const t = p.totals;
  const cachePct = Math.round((t.cacheRead / Math.max(1, t.totalTokens)) * 100);
  const rangeLabel = RANGES.find((r) => r.key === rangeKey).label;
  // Sin precios no tiene sentido graficar dolares: se cae a tokens.
  const metricaEfectiva = money.show ? metric : (metric === 'costUSD' ? 'tokens' : metric);
  const metricDef = METRICS.find((m) => m.id === metricaEfectiva);
  const ahorro = t.costNoCacheUSD - t.costUSD;
  const ahorroPct = Math.round((1 - t.costUSD / Math.max(1e-9, t.costNoCacheUSD)) * 100);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 6 }}>
        <span className="dim" style={{ fontSize: 11.5 }}>Período</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={'btn sm' + (rangeKey === r.key ? ' primary' : '')}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
        <span className="right chip dim">
          {p.sessions} {p.sessions === 1 ? 'sesión' : 'sesiones'} · {fmtInt(p.userTurns)} prompts tuyos
        </span>
      </div>

      <div className="grid g5">
        <div className="card stat" title="Costo total del periodo dividido por los mensajes que escribiste vos">
          <div className="label">Por consulta tuya</div>
          <div className="value">{p.userTurns ? money.valor(t.costUSD / p.userTurns, Math.round(t.totalTokens / p.userTurns)) : '—'}</div>
          <div className="sub">promedio sobre {fmtInt(p.userTurns)} prompts{money.aprox}</div>
        </div>
        <div className="card stat" title="Un prompt tuyo dispara muchos requests: cada uso de herramienta es uno mas">
          <div className="label">Por request al modelo</div>
          <div className="value">{t.requests ? money.valor(t.costUSD / t.requests, Math.round(t.totalTokens / t.requests)) : '—'}</div>
          <div className="sub">{fmtInt(t.requests)} llamadas{money.aprox}</div>
        </div>
        <div className="card stat" title="Porcentaje de tokens que fueron relectura del contexto ya cacheado, facturados a 1/10">
          <div className="label">Lectura de caché</div>
          <div className="value">{cachePct}%</div>
          <div className="sub">{fmtTokens(t.cacheRead)} a 1/10 de tarifa</div>
        </div>
        <div className="card stat" title="Grabar el contexto en cache cuesta mas caro que el input normal, pero se amortiza en las relecturas">
          <div className="label">Escritura de caché</div>
          <div className="value">{fmtTokens(t.cacheWrite)}</div>
          <div className="sub">se paga 1.25×–2× el input</div>
        </div>
        <div className="card stat" title="Los subagentes y los agentes de workflow tienen transcripts propios: este es su gasto dentro del periodo">
          <div className="label">{money.show ? 'Gasto de subagentes' : 'Peso de subagentes'}</div>
          <div className="value">{money.show ? fmtUSD(t.agentCostUSD) : Math.round((t.agentCostUSD / Math.max(1e-9, t.costUSD)) * 100) + '%'}</div>
          <div className="sub">
            {t.costUSD ? Math.round((t.agentCostUSD / t.costUSD) * 100) : 0}% del total del período
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Actividad · {rangeLabel}</h3>
          <div className="right row" style={{ gap: 6 }}>
            <select value={metricaEfectiva} onChange={(e) => setMetric(e.target.value)}>
              {METRICS.filter((m) => money.show || m.id !== 'costUSD')
                .map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={metricaEfectiva === 'costUSD' ? stacked : series} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid stroke="#2c2c29" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#6b675f', fontSize: 10 }} tickLine={false} axisLine={false}
                tickFormatter={(d) => String(d).slice(5)} minTickGap={12} />
              <YAxis tick={{ fill: '#6b675f', fontSize: 10 }} tickLine={false} axisLine={false}
                tickFormatter={(v) => (metricaEfectiva === 'costUSD' ? '$' + v : fmtTokens(v))} />
              <Tooltip
                contentStyle={{ background: '#1f1f1d', border: '1px solid #2c2c29', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#918c81' }}
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                formatter={(v, n) => [metricDef.fmt(v), n]}
              />
              {metricaEfectiva === 'costUSD' ? (
                <>
                  <Legend wrapperStyle={{ fontSize: 11, color: '#918c81' }} />
                  {modelLabels.map((label, i) => (
                    <Bar key={label} dataKey={label} stackId="a" fill={modelColor(label, i)} />
                  ))}
                </>
              ) : (
                <Bar dataKey={metricaEfectiva} fill="#d97757" />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>Desglose de tokens · {rangeLabel}</h3>
          {[
            ['Lectura de caché', t.cacheRead, 'var(--green)'],
            ['Escritura de caché', t.cacheWrite, 'var(--yellow)'],
            ['Salida', t.output, 'var(--accent)'],
            ['Razonamiento (dentro de salida)', t.thinking, 'var(--purple)'],
            ['Input sin cachear', t.input, 'var(--blue)'],
          ].map(([label, value, color]) => (
            <div className="bar-row" key={label}>
              <span className="name trunc">{label}</span>
              <span className="track">
                <span className="fill" style={{ width: `${(value / Math.max(1, t.totalTokens)) * 100}%`, background: color }} />
              </span>
              <span className="val">{fmtTokens(value)}</span>
            </div>
          ))}
          <div className="dim" style={{ fontSize: 11, marginTop: 10 }}>
            El grueso es caché: Claude Code reenvía el contexto en cada request pero lo paga a 1/10.
            {money.show
              ? `Sin prompt caching este mismo tráfico habría costado ${fmtUSD(t.costNoCacheUSD)} (aprox.): el caché te ahorró ${fmtUSD(ahorro)}, un ${ahorroPct}%.`
              : `Sin prompt caching se habrían facturado los mismos tokens pero a tarifa de input completa: el caché evita pagar ${ahorroPct}% de más.`}
          </div>
        </div>

        <div className="card">
          <h3>Por modelo · {rangeLabel}</h3>
          {!p.byModel.length ? <div className="dim">Sin actividad en el período.</div> : (
            <table>
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th className="n">Requests</th>
                  <th className="n">Tokens</th>
                  <th className="n">{money.show ? 'Equivalente (aprox.)' : 'Sin precios'}</th>
                </tr>
              </thead>
              <tbody>
                {p.byModel.map((m) => (
                  <tr key={m.key}>
                    <td>
                      <span className="chip" style={{ borderColor: modelColor(m.label), color: modelColor(m.label) }}>
                        {m.label}
                      </span>
                    </td>
                    <td className="n">{fmtInt(m.requests)}</td>
                    <td className="n">{fmtTokens(m.input + m.output + m.cacheRead + m.cacheWrite)}</td>
                    <td className="n">{money.show ? fmtUSD(m.costUSD) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Sesiones</h3>
          <span className="chip dim">todas, sin filtrar por período</span>
          <div className="right row" style={{ gap: 6 }}>
            <span className="dim" style={{ fontSize: 11 }}>ordenar por</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="costUSD">costo</option>
              <option value="tokens">tokens</option>
              <option value="perTurn">costo por prompt</option>
              <option value="recent">más reciente</option>
            </select>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Sesión</th>
              <th>Proyecto</th>
              <th className="n">Prompts</th>
              <th className="n">Requests</th>
              <th className="n">Tokens</th>
              <th className="n">Agentes</th>
              <th className="n">{money.show ? 'Equivalente' : 'Tokens'}</th>
              <th className="n">Por prompt</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.machineId + s.sessionId}>
                <td style={{ maxWidth: 300 }}>
                  <div className="trunc" title={s.title}>{s.title}</div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {fmtDate(s.endedAt)}
                    {s.isRemote && ' · ' + s.machineLabel}
                  </div>
                </td>
                <td className="trunc" style={{ maxWidth: 150 }} title={s.cwd}>{basename(s.cwd)}</td>
                <td className="n">{s.userTurns}</td>
                <td className="n">{fmtInt(s.totals.requests)}</td>
                <td className="n">{fmtTokens(s.totals.totalTokens)}</td>
                <td className="n">{s.agents ? (s.agents.count || '—') : '—'}</td>
                <td className="n"><b>{money.valor(s.totals.costUSD, s.totals.totalTokens)}</b></td>
                <td className="n dim">
                  {s.userTurns
                    ? money.valor(s.totals.costUSD / s.userTurns, Math.round(s.totals.totalTokens / s.userTurns))
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
