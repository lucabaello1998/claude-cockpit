import React, { useEffect, useState } from 'react';
import { fmtAgo, fmtDate, basename } from '../util.js';
import SyncPanel from './SyncPanel.jsx';
import PackagePanel from './PackagePanel.jsx';
import PricingPanel from './PricingPanel.jsx';
import ProjectsPanel from './ProjectsPanel.jsx';
import Requisitos from './Requisitos.jsx';
import McpPanel from './McpPanel.jsx';
import SkillsPanel from './SkillsPanel.jsx';
import PluginsPanel from './PluginsPanel.jsx';
import HooksPanel from './HooksPanel.jsx';
import WorkflowsPanel from './WorkflowsPanel.jsx';
import { esSeatTier, esBilling, esOrgType, esModelBlurb } from '../i18n.js';

const SECTIONS = [
  { id: 'requisitos', label: 'Requisitos' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'projects', label: 'Proyectos' },
  { id: 'sync', label: 'Maquinas' },
  { id: 'pkg', label: 'Paquete' },
  { id: 'pricing', label: 'Precios y datos' },
  { id: 'account', label: 'Cuenta' },
  { id: 'history', label: 'Historial' },
];

// La etiqueta tenia ancho fijo y no cortaba: una clave larga como
// "env · CLAUDE_CODE_USE_POWERSHELL_TOOL" se desbordaba encima del valor.
function KV({ k, v }) {
  return (
    <div
      className="row"
      style={{
        padding: '5px 0', gap: 12, alignItems: 'baseline',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <span
        className="dim"
        title={String(k)}
        style={{ flex: '0 1 200px', minWidth: 110, overflowWrap: 'anywhere' }}
      >
        {k}
      </span>
      <span
        className="trunc"
        title={String(v)}
        style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'right' }}
      >
        {v == null || v === '' ? '—' : String(v)}
      </span>
    </div>
  );
}

export default function ConfigPanel({ snap, flash, seccion }) {
  const [section, setSection] = useState(seccion || 'requisitos');
  // Un consejo del repaso puede mandarte directo a una seccion.
  useEffect(() => { if (seccion) setSection(seccion); }, [seccion]);
  const c = snap.config;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={'btn sm' + (section === s.id ? ' primary' : '')}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'requisitos' && <Requisitos flash={flash} />}
      {section === 'mcp' && <McpPanel snap={snap} flash={flash} />}

      {section === 'skills' && <SkillsPanel snap={snap} flash={flash} />}

      {section === 'workflows' && <WorkflowsPanel flash={flash} />}

      {section === 'hooks' && <HooksPanel flash={flash} />}

      {section === 'plugins' && <PluginsPanel flash={flash} />}

      {section === 'projects' && <ProjectsPanel snap={snap} flash={flash} />}

      {section === 'sync' && <SyncPanel snap={snap} flash={flash} />}

      {section === 'pkg' && <PackagePanel flash={flash} />}

      {section === 'pricing' && <PricingPanel flash={flash} />}

      {section === 'account' && (
        <div className="grid g2">
          <div className="card">
            <h3>Cuenta</h3>
            <KV k="Email" v={c.account.email} />
            <KV k="Nombre" v={c.account.displayName} />
            <KV k="Organización" v={`${c.account.organizationName || '—'} (${esOrgType(c.account.organizationType)})`} />
            <KV k="Rol" v={c.account.organizationRole} />
            <KV k="Plan / asiento" v={esSeatTier(c.account.seatTier)} />
            <KV k="Facturación" v={esBilling(c.account.billingType)} />
            <KV k="Uso extra habilitado" v={c.account.hasExtraUsageEnabled ? 'sí' : 'no'} />
            <KV k="Cuenta creada" v={fmtDate(c.account.accountCreatedAt, false)} />
            <KV k="Suscripción desde" v={fmtDate(c.account.subscriptionCreatedAt, false)} />
            <KV k="Primer token en Code" v={fmtDate(c.account.firstTokenDate, false)} />
            <KV k="Instalación" v={c.account.installMethod} />
            <KV k="Arranques" v={c.account.numStartups} />
            <div className="dim" style={{ fontSize: 11.5, marginTop: 12 }}>
              Todo esto sale de <code>~/.claude.json</code>, que Claude Code mantiene al día solo.
              La app <b>no</b> lee ni usa el token de <code>.credentials.json</code>
              {c.account.hasCredentialsFile ? ' (el archivo existe, pero no se toca).' : '.'}
            </div>
          </div>

          <div className="card">
            <h3>Ajustes activos</h3>
            <KV k="Modelo" v={c.settings.model} />
            <KV k="Nivel de effort" v={c.settings.effortLevel} />
            <KV k="Tema" v={c.settings.theme} />
            {Object.entries(c.settings.env || {}).map(([k, v]) => <KV key={k} k={'env · ' + k} v={v} />)}

            {c.availableModels && c.availableModels.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Modelos extra que te ofrece el selector</h3>
                {c.availableModels.map((m) => (
                  <div key={m.id} style={{ marginBottom: 10 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b>{m.label}</b>
                      <span className="chip mono" style={{ fontSize: 10 }}>{m.id}</span>
                      {m.usesCredits && (
                        <span
                          className="chip warn"
                          title="No sale de tu plan: gasta creditos de uso extra. Sin creditos no lo vas a poder usar."
                        >
                          consume créditos
                        </span>
                      )}
                    </div>
                    {m.description && (
                      <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }} title={m.description}>
                        {esModelBlurb(m.description)}
                      </div>
                    )}
                  </div>
                ))}
                <div className="dim" style={{ fontSize: 11.5 }}>
                  Los que consumen créditos no salen del plan: gastan créditos de uso extra.
                  Tu estado ahí lo ves en el panel de límites del Resumen.
                </div>
              </>
            )}
            <div className="row" style={{ gap: 6, marginTop: 12 }}>
              <button className="btn sm" onClick={() => window.cockpit.openPath(c.paths.claudeDir)}>
                Abrir carpeta ~/.claude
              </button>
            </div>
            {snap.reports && snap.reports.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Reportes de uso generados</h3>
                {snap.reports.map((r) => (
                  <div className="row" key={r.path} style={{ padding: '3px 0' }}>
                    <span className="trunc" style={{ flex: 1 }}>{r.file}</span>
                    <span className="dim">{fmtAgo(new Date(r.mtimeMs).toISOString())}</span>
                    <button className="btn sm" onClick={() => window.cockpit.openPath(r.path)}>abrir</button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {section === 'history' && (
        <div className="card">
          <h3>Últimos prompts tipeados ({c.promptHistory.length})</h3>
          <table>
            <thead><tr><th className="n">Cuándo</th><th>Proyecto</th><th>Prompt</th></tr></thead>
            <tbody>
              {c.promptHistory.map((h, i) => (
                <tr key={i}>
                  <td className="n dim" style={{ whiteSpace: 'nowrap' }}>{fmtAgo(new Date(h.ts).toISOString())}</td>
                  <td className="dim trunc" style={{ maxWidth: 150 }} title={h.project}>{basename(h.project)}</td>
                  <td style={{ maxWidth: 700 }}>
                    <div className="trunc" title={h.display}>{h.display}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
