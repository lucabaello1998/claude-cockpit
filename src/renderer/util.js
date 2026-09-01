export function fmtInt(n) {
  return new Intl.NumberFormat('es-AR').format(Math.round(n || 0));
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

export function fmtUSD(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + fmtInt(v);
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const opts = withTime
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleString('es-AR', opts);
}

export function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d} d`;
  return fmtDate(iso, false);
}

export function fmtUntil(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return '—';
  if (ms <= 0) return 'ya se reinició';
  const min = Math.round(ms / 60000);
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (h < 48) return `en ${h} h ${rem} min`;
  return `en ${Math.round(h / 24)} días`;
}

export function fmtDuration(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function basename(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function meterColor(pct) {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 70) return 'var(--yellow)';
  return 'var(--green)';
}

const MODEL_COLORS = {
  'Opus 5': '#d97757',
  'Opus 4.8': '#c9694c',
  'Sonnet 5': '#6c9fd8',
  'Sonnet 4.6': '#5384b8',
  'Haiku 4.5': '#7cae7a',
  'Fable 5': '#a98bd4',
};
export function modelColor(label, i = 0) {
  return MODEL_COLORS[label] || ['#918c81', '#d9b45b', '#a98bd4', '#7cae7a'][i % 4];
}

export function highlight(text, query) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return [
    text.slice(0, i),
    { mark: text.slice(i, i + query.length) },
    text.slice(i + query.length),
  ];
}
