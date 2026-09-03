import React, { useState } from 'react';
import Requisitos from './Requisitos.jsx';

// Aviso de primer uso. La app lee archivos personales y ahora también puede
// escribir la configuración de Claude Code: eso hay que decirlo antes, no
// esconderlo en un README.

const LEE = [
  ['~/.claude/projects/**/*.jsonl', 'Tus conversaciones completas, con el detalle de tokens de cada request.'],
  ['~/.claude.json', 'Tipo de cuenta, organización, plan, MCPs, skills usadas y los porcentajes de límite que muestra /usage.'],
  ['~/.claude/settings.json', 'Modelo, nivel de effort y hooks configurados.'],
  ['~/.claude/usage-data/', 'Métricas por sesión y el análisis que genera Claude Code al cerrarlas.'],
  ['~/.claude/.credentials.json', 'SOLO cuando apretás "Actualizar uso": se lee el token para consultar tus límites en vivo. No se guarda ni se copia a ningún lado.'],
];

export default function Consent({ onAccept, flash }) {
  const [busy, setBusy] = useState(false);
  // Dos pasos: primero que lee la app, despues que le falta para funcionar del
  // todo. Antes el segundo no existia y te enterabas de que faltaba un MCP
  // cuando encontrabas un boton gris.
  const [paso, setPaso] = useState(1);

  const aceptar = async () => {
    setBusy(true);
    try { await window.cockpit.acceptConsent(); } catch { /* igual seguimos */ }
    setBusy(false);
    setPaso(2);
  };

  if (paso === 2) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div className="card" style={{ maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="dot" style={{
              width: 11, height: 11, borderRadius: 3, background: 'var(--accent)', display: 'inline-block',
            }} />
            <b style={{ fontSize: 15 }}>Lo opcional: qué podés conectar e instalar</b>
          </div>
          <Requisitos flash={flash || (() => {})} compacto />
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            <button className="btn primary" onClick={onAccept}>Listo, entrar</button>
            <span className="dim" style={{ fontSize: 11 }}>
              Podés configurarlo cuando quieras desde Configuración → Requisitos
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div className="card" style={{ maxWidth: 680, maxHeight: '90vh', overflow: 'auto' }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="dot" style={{
            width: 11, height: 11, borderRadius: 3, background: 'var(--accent)', display: 'inline-block',
          }} />
          <b style={{ fontSize: 15 }}>Qué lee esta app, y qué hace con eso</b>
        </div>

        <p style={{ fontSize: 12.5, marginTop: 0, color: 'var(--muted)' }}>
          Claude Cockpit lee los archivos que Claude Code deja en tu disco y los muestra en pantalla.
          <b style={{ color: 'var(--text)' }}> Todo se procesa en esta máquina y nada se manda a ningún
          servidor</b>, con una sola excepción que está marcada abajo.
        </p>

        {LEE.map(([ruta, para]) => (
          <div key={ruta} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="mono" style={{ fontSize: 11.5 }}>{ruta}</div>
            <div className="dim" style={{ fontSize: 11.5 }}>{para}</div>
          </div>
        ))}

        <div className="card" style={{ marginTop: 12, background: 'var(--panel-2)' }}>
          <b style={{ fontSize: 12.5 }}>La única conexión a internet</b>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.7 }}>
            El botón <b>Actualizar uso</b> consulta tus límites a <span className="mono">api.anthropic.com</span> con
            tu sesión de Claude Code, y <b>Buscar precios actualizados</b> lee la página de precios de la
            documentación. Nada más sale de acá. Tu token no se guarda ni se copia.
          </div>
        </div>

        <div className="card" style={{ marginTop: 10, background: 'var(--panel-2)', borderColor: 'rgba(217,180,91,0.35)' }}>
          <b style={{ fontSize: 12.5, color: 'var(--yellow)' }}>Cuándo escribe</b>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.7 }}>
            Solo si importás un paquete de configuración, y siempre con backup previo y confirmación
            tuya por cada cosa. Nunca marca un proyecto como confiado: esa decisión la seguís tomando
            vos en Claude Code.
          </div>
        </div>

        <div className="dim" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
          Un detalle sobre los números: los <b>tokens son exactos</b>, salen del transcript. Los
          precios en dólares son una <b>estimación a tarifa API pública</b> — tu cuenta es por
          suscripción, así que sirven para comparar sesiones, no como factura. Podés apagarlos y ver
          solo tokens desde Configuración.
        </div>

        <div className="row" style={{ gap: 8, marginTop: 16 }}>
          <button className="btn primary" onClick={aceptar} disabled={busy}>Entendido, seguir</button>
          <span className="dim" style={{ fontSize: 11 }}>
            Podés volver a leer esto en Configuración → Precios y datos
          </span>
        </div>
      </div>
    </div>
  );
}
