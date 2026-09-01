import { esSeatTier } from './i18n.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Overview from './components/Overview.jsx';
import Tokens from './components/Tokens.jsx';
import Conversations from './components/Conversations.jsx';
import ConfigPanel from './components/ConfigPanel.jsx';
import MemoryPanel from './components/MemoryPanel.jsx';
import BoardsPanel from './components/BoardsPanel.jsx';
import { fmtAgo } from './util.js';
import Consent from './components/Consent.jsx';
import Repaso from './components/Repaso.jsx';
import { setShowCosts, useShowCosts } from './money.js';

const TABS = [
  { id: 'overview', label: 'Resumen', icon: '◈' },
  { id: 'repaso', label: 'Repaso', icon: '☀' },
  { id: 'tokens', label: 'Tokens y costo', icon: '◱' },
  { id: 'chats', label: 'Conversaciones', icon: '❯' },
  { id: 'memory', label: 'Memorias', icon: '⬡' },
  { id: 'boards', label: 'Boards', icon: '▦' },
  { id: 'config', label: 'Configuración', icon: '⚙' },
];

export default function App() {
  const [tab, setTab] = useState('overview');
  const [snap, setSnap] = useState(null);
  const [memory, setMemory] = useState(null);
  const [busy, setBusy] = useState(true);
  const [toast, setToast] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [consent, setConsent] = useState(null);
  // Cuantos consejos tiene el repaso, para el globito de la barra.
  const [repaso, setRepaso] = useState(0);
  // Un consejo puede mandarte a una seccion puntual de Configuración.
  const [seccionConfig, setSeccionConfig] = useState(null);
  const toastTimer = useRef(null);
  const showCosts = useShowCosts();

  const flash = useCallback((text, isError) => {
    clearTimeout(toastTimer.current);
    setToast({ text, isError });
    toastTimer.current = setTimeout(() => setToast(null), isError ? 8000 : 2600);
  }, []);

  const load = useCallback(async (announce) => {
    try {
      const [s, m] = await Promise.all([window.cockpit.snapshot(), window.cockpit.memory()]);
      setSnap(s);
      setMemory(m);
      setLastUpdate(new Date().toISOString());
      if (announce) flash(announce);
    } catch (e) {
      flash('Error al leer los datos: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  }, [flash]);

  // El repaso se arma una vez por dia; aca solo se cuenta para el globito.
  useEffect(() => {
    window.cockpit.briefing(false)
      .then((r) => setRepaso((r.items || []).length))
      .catch(() => setRepaso(0));
  }, []);

  useEffect(() => { load(); }, [load]);

  // El aviso de primer uso y la preferencia dolares/tokens viven en la config
  // de la app, no en localStorage: tienen que sobrevivir a reinstalar.
  useEffect(() => {
    window.cockpit.pricingInfo()
      .then((r) => { setShowCosts(r.showCosts); setConsent(!!r.consentAt); })
      .catch(() => setConsent(true));
  }, []);

  // El proceso principal vigila ~/.claude y avisa cuando algo cambió.
  useEffect(() => {
    const offUpd = window.cockpit.onUpdated((d) => {
      load(d.reparsed ? `Actualizado · ${d.reparsed} transcript${d.reparsed === 1 ? '' : 's'}` : null);
    });
    const offIdx = window.cockpit.onIndexing((p) => {
      setToast({ text: `Indexando ${p.done}/${p.total}…` });
    });
    const offErr = window.cockpit.onError((e) => flash(`${e.where}: ${e.message}`, true));
    return () => { offUpd(); offIdx(); offErr(); };
  }, [load, flash]);

  const manualRefresh = async () => {
    setBusy(true);
    try {
      await window.cockpit.refresh();
      await load('Reindexado completo');
    } catch (e) {
      flash('No se pudo reindexar: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const active = TABS.find((t) => t.id === tab);
  const cfg = snap && snap.config;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <b>Claude Cockpit</b>
        </div>

        {TABS.map((t) => (
          <div
            key={t.id}
            className={'nav-item' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            <span style={{ width: 14, textAlign: 'center', opacity: 0.85 }}>{t.icon}</span>
            <span>{t.label}</span>
            {t.id === 'repaso' && repaso > 0 && (
              <span className="chip badge" style={{ background: 'var(--accent)', color: '#1a0f0a' }}>
                {repaso}
              </span>
            )}
            {t.id === 'chats' && snap && <span className="chip badge">{snap.counts.sessions}</span>}
            {t.id === 'memory' && memory && (
              <span className="chip badge">
                {memory.claudeMemory.reduce((a, s) => a + s.entries.length, 0) +
                  memory.providers.reduce((a, p) => a + p.stores.length, 0)}
              </span>
            )}
          </div>
        ))}

        <div className="sidebar-foot">
          {cfg && cfg.account && (
            <>
              <div className="trunc" title={cfg.account.email}>{cfg.account.displayName || cfg.account.email}</div>
              <div className="trunc">{cfg.account.organizationName}</div>
              <div>{esSeatTier(cfg.account.seatTier)}</div>
            </>
          )}
          <div style={{ marginTop: 6 }}>
            {busy ? <span className="spin" /> : `Sync ${fmtAgo(lastUpdate)}`}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{active.label}</h1>
          <div className="spacer" />
          {snap && (
            <span className="chip dim">
              {snap.counts.sessions} sesiones · {snap.counts.requests.toLocaleString('es-AR')} requests
              {snap.machines && snap.machines.length > 1 && ` · ${snap.machines.length} máquinas`}
            </span>
          )}
          <button
            className="btn sm"
            title={showCosts
              ? 'Estás viendo costo estimado en dólares. Tocá para ver solo tokens, que son exactos.'
              : 'Estás viendo tokens, que son exactos. Tocá para ver el costo estimado.'}
            onClick={async () => {
              const v = !showCosts;
              setShowCosts(v);
              try { await window.cockpit.setShowCosts(v); } catch { /* queda en memoria */ }
            }}
          >
            {showCosts ? '$ dólares' : '# tokens'}
          </button>
          <button className="btn sm" onClick={manualRefresh} disabled={busy}>
            {busy ? 'Indexando…' : 'Reindexar'}
          </button>
        </div>

        <div className={'content' + (tab === 'chats' ? ' flush' : '')}>
          {!snap ? (
            <div className="empty"><span className="spin" /> Leyendo ~/.claude…</div>
          ) : tab === 'repaso' ? (
            <Repaso flash={flash} onIr={(destino) => {
              // Los consejos apuntan a una sección: "hooks" y "workflows" son
              // pestañas de Configuración, no de la barra lateral.
              if (destino === 'boards') setTab('boards');
              else { setTab('config'); setSeccionConfig(destino); }
            }} />
          ) : tab === 'overview' ? (
            <Overview snap={snap} memory={memory} onGoto={setTab} />
          ) : tab === 'tokens' ? (
            <Tokens snap={snap} />
          ) : tab === 'chats' ? (
            <Conversations snap={snap} flash={flash} />
          ) : tab === 'boards' ? (
            <BoardsPanel flash={flash} />
          ) : tab === 'memory' ? (
            <MemoryPanel memory={memory} flash={flash} />
          ) : (
            <ConfigPanel snap={snap} flash={flash} seccion={seccionConfig} />
          )}
        </div>
      </main>

      {consent === false && <Consent onAccept={() => setConsent(true)} flash={flash} />}

      {toast && (
        <div className={'toast' + (toast.isError ? ' err' : '')}>{toast.text}</div>
      )}
    </div>
  );
}
