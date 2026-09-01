import React from 'react';

// Barra de filtros del board. Es la misma para Azure DevOps y para los
// tableros propios: los dos lados devuelven `responsables` y `sprints` con la
// misma forma, asi que no hace falta una version por proveedor.
//
// En ADO los filtros se aplican en la consulta (WIQL), asi que cambiar uno
// vuelve a pedir los datos. En un tablero propio se filtra en memoria, que es
// instantaneo. Por eso `onCambio` avisa y quien llama decide que hacer.

const NIVELES = [
  { id: 'hito', label: 'Hitos', color: '#a98bd4' },
  { id: 'feature', label: 'Features', color: '#6c9fd8' },
  { id: 'pbi', label: 'PBIs', color: '#d97757' },
  { id: 'task', label: 'Tasks', color: '#7cae7a' },
];

export default function BoardFilters({
  filtros, onCambio, responsables, sprints, estados, remoto, cargando, resumen,
}) {
  const f = filtros || {};
  const set = (cambio) => onCambio({ ...f, ...cambio });

  const nivelesElegidos = f.niveles || [];
  const alternarNivel = (id) => {
    const y = nivelesElegidos.includes(id)
      ? nivelesElegidos.filter((x) => x !== id)
      : [...nivelesElegidos, id];
    set({ niveles: y });
  };

  const estadosElegidos = f.estados || [];
  const alternarEstado = (id) => {
    const y = estadosElegidos.includes(id)
      ? estadosElegidos.filter((x) => x !== id)
      : [...estadosElegidos, id];
    set({ estados: y });
  };

  const hayFiltro = nivelesElegidos.length || estadosElegidos.length || f.responsable
    || f.soloMias || f.sprint || f.texto || f.incluirCerradas;

  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>

        {/* Nivel de la jerarquia: lo que mas se usa, asi que va primero y como
            botones en vez de desplegable. */}
        <div className="row" style={{ gap: 4 }}>
          {NIVELES.map((n) => {
            const on = nivelesElegidos.includes(n.id);
            return (
              <button
                key={n.id}
                className={'btn sm' + (on ? ' primary' : '')}
                style={on ? { background: n.color, borderColor: n.color, color: '#1a0f0a' } : { borderColor: n.color + '66', color: n.color }}
                onClick={() => alternarNivel(n.id)}
                title={on ? 'Sacar este nivel del filtro' : 'Mostrar solo estos'}
              >
                {n.label}
              </button>
            );
          })}
        </div>

        <span style={{ width: 1, height: 20, background: 'var(--line)' }} />

        <label className="chip" style={{ cursor: 'pointer', gap: 6 }} title="Solo lo que está a tu nombre">
          <input
            type="checkbox"
            checked={!!f.soloMias}
            onChange={(e) => set({ soloMias: e.target.checked, responsable: '' })}
          />
          Mías
        </label>

        <select
          value={f.soloMias ? '' : (f.responsable || '')}
          disabled={!!f.soloMias}
          onChange={(e) => set({ responsable: e.target.value })}
          style={{ fontSize: 11.5, minWidth: 150 }}
          title={f.soloMias ? 'Destildá "Mías" para elegir otra persona' : 'Filtrar por responsable'}
        >
          <option value="">Responsable: todos</option>
          {(responsables || []).map((r) => (
            <option key={r.valor} value={r.valor}>
              {r.etiqueta} ({r.cuantas})
            </option>
          ))}
        </select>

        <select
          value={f.sprint || ''}
          onChange={(e) => set({ sprint: e.target.value })}
          style={{ fontSize: 11.5, minWidth: 140 }}
        >
          <option value="">Sprint: todos</option>
          {(sprints || []).map((s) => (
            <option key={s.id} value={s.path}>
              {s.nombre}{s.estado === 'actual' ? ' · en curso' : ''}
              {s.cuantas != null ? ` (${s.cuantas})` : ''}
            </option>
          ))}
        </select>

        <input
          type="search"
          placeholder="Buscar en el título…"
          value={f.texto || ''}
          onChange={(e) => set({ texto: e.target.value })}
          style={{ fontSize: 11.5, minWidth: 170 }}
        />

        <label className="chip" style={{ cursor: 'pointer', gap: 6 }} title="Por defecto se ocultan las cerradas y quitadas">
          <input
            type="checkbox"
            checked={!!f.incluirCerradas}
            onChange={(e) => set({ incluirCerradas: e.target.checked })}
          />
          Cerradas
        </label>

        {cargando && <span className="spin" />}

        <div className="right row" style={{ gap: 8 }}>
          {resumen && <span className="dim" style={{ fontSize: 11.5 }}>{resumen}</span>}
          {hayFiltro && (
            <button className="btn sm" onClick={() => onCambio({})} title="Sacar todos los filtros">
              Limpiar
            </button>
          )}
        </div>
      </div>

      {/* Los estados dependen del proyecto, asi que se muestran solo cuando ya
          se sabe cuales hay. */}
      {(estados || []).length > 1 && (
        <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
          <span className="dim" style={{ fontSize: 11 }}>Estado</span>
          {estados.map((e) => {
            const on = estadosElegidos.includes(e);
            return (
              <button
                key={e}
                className={'btn sm' + (on ? ' primary' : '')}
                onClick={() => alternarEstado(e)}
                style={{ fontSize: 10.5 }}
              >
                {e}
              </button>
            );
          })}
        </div>
      )}

      {remoto && f.texto && (
        <div className="dim" style={{ fontSize: 10.5, marginTop: 6 }}>
          La búsqueda va contra Azure DevOps y solo mira el título.
        </div>
      )}
    </div>
  );
}
