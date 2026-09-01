import React, { useCallback, useState } from 'react';
import { fmtInt, fmtBytes, fmtDate } from '../util.js';

const SECCIONES = [
  { id: 'mcpServers', label: 'Servidores MCP', detalle: 'Definiciones con la ruta parametrizada. Viajan los NOMBRES de las variables de entorno pero nunca sus valores: los tokens quedan acá. Los conectores de claude.ai tampoco viajan: cada uno autoriza el suyo.' },
  { id: 'skills', label: 'Skills', detalle: 'El contenido real de cada SKILL.md, no solo el nombre.' },
  { id: 'workflows', label: 'Workflows', detalle: 'Los archivos .js completos.' },
  { id: 'hooks', label: 'Hooks', detalle: 'Los scripts y las reglas de settings.json.' },
  { id: 'projects', label: 'Proyectos', detalle: 'Rutas, permisos y la receta de indexado. El índice en sí no viaja: pesa megabytes y es de este disco.' },
  { id: 'plugins', label: 'Plugins', detalle: 'Los marketplaces (que son repos git) y cuáles tenés habilitados. Los archivos no viajan: se vuelven a clonar del repo.' },
  { id: 'boards', label: 'Boards propios', detalle: 'Tus tableros con sus columnas, tarjetas y jerarquía. Los de Azure DevOps y Jira no: viven allá.' },
  { id: 'memory', label: 'Memorias', detalle: 'Hechos que Claude guardó sobre vos y tus proyectos. Personal: pensalo antes de compartirlo.' },
];

const ACCION_CHIP = {
  agrega: 'on', pisa: 'warn', fusiona: 'info', igual: '',
};
const ACCION_TXT = {
  agrega: 'se agrega', pisa: 'pisa lo que hay', fusiona: 'se fusiona', igual: 'ya está igual',
};

export default function PackagePanel({ flash }) {
  const [incluir, setIncluir] = useState({
    mcpServers: true, skills: true, workflows: true, hooks: true, projects: true,
    plugins: true, boards: true, memory: false,
  });
  const [resumen, setResumen] = useState(null);
  const [plan, setPlan] = useState(null);
  const [pkgInfo, setPkgInfo] = useState(null);
  const [seleccion, setSeleccion] = useState({});
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState(null);

  const previsualizar = useCallback(async () => {
    setBusy(true);
    try {
      setResumen(await window.cockpit.pkgPreview(incluir));
    } catch (e) {
      flash('No se pudo armar el paquete: ' + e.message, true);
    } finally { setBusy(false); }
  }, [incluir, flash]);

  const exportar = async () => {
    setBusy(true);
    try {
      const file = await window.cockpit.pkgExport(incluir);
      if (file) flash('Paquete guardado en ' + file);
    } catch (e) {
      flash('No se pudo exportar: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const abrirParaImportar = async () => {
    setBusy(true);
    setResultado(null);
    try {
      const r = await window.cockpit.pkgOpen();
      if (!r) return;
      setPlan(r.plan);
      setPkgInfo(r.info);
      // Por defecto se tilda todo lo que cambia algo, menos lo que ya está igual.
      const sel = {};
      for (const [sec, items] of Object.entries(r.plan)) {
        sel[sec] = items.filter((i) => i.action !== 'igual').map((i) => i.id);
      }
      setSeleccion(sel);
    } catch (e) {
      flash('No se pudo leer el paquete: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const aplicar = async () => {
    setBusy(true);
    try {
      const r = await window.cockpit.pkgApply(seleccion);
      setResultado(r);
      setPlan(null);
      flash(r.errores.length ? 'Importado con errores' : `Importado: ${r.hecho.length} cosas`, !!r.errores.length);
    } catch (e) {
      flash('Falló la importación: ' + e.message, true);
    } finally { setBusy(false); }
  };

  const toggleItem = (sec, id) => {
    setSeleccion((s) => {
      const cur = s[sec] || [];
      return { ...s, [sec]: cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]) };
    });
  };

  const totalSeleccionado = Object.values(seleccion).reduce((a, v) => a + v.length, 0);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <h3>Exportar tu setup</h3>
        <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
          Genera un archivo con tu configuración de Claude Code para llevarla a otra máquina
          o pasársela a alguien. Nunca incluye credenciales ni datos de tu cuenta.
        </p>

        {SECCIONES.map((s) => (
          <label key={s.id} className="row" style={{ gap: 8, padding: '6px 0', cursor: 'pointer', alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={!!incluir[s.id]}
              onChange={(e) => { setIncluir((v) => ({ ...v, [s.id]: e.target.checked })); setResumen(null); }}
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>
              <b style={{ fontSize: 12.5 }}>{s.label}</b>
              {s.id === 'memory' && <span className="chip warn" style={{ marginLeft: 6, fontSize: 10 }}>personal</span>}
              <div className="dim" style={{ fontSize: 11.5 }}>{s.detalle}</div>
            </span>
            {resumen && (
              <span className="chip" style={{ marginTop: 2 }}>
                {fmtInt(resumen.counts[s.id] || 0)}
                {s.id === 'hooks' && resumen.counts.hookRules ? ` + ${resumen.counts.hookRules} reglas` : ''}
                {s.id === 'plugins' && resumen.counts.pluginsHabilitados
                  ? ` · ${resumen.counts.pluginsHabilitados} habilitados` : ''}
                {s.id === 'boards' && resumen.counts.boardCards
                  ? ` · ${fmtInt(resumen.counts.boardCards)} tarjetas` : ''}
              </span>
            )}
          </label>
        ))}

        <div className="row" style={{ gap: 6, marginTop: 12 }}>
          <button className="btn sm" onClick={previsualizar} disabled={busy}>Ver qué incluye</button>
          <button className="btn sm primary" onClick={exportar} disabled={busy}>Exportar a un archivo…</button>
          {resumen && <span className="dim" style={{ fontSize: 11.5 }}>{fmtBytes(resumen.sizeBytes)}</span>}
        </div>
      </div>

      <div className="card">
        <h3>Importar un paquete</h3>
        <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
          Escribe la configuración de Claude Code de verdad. Antes de tocar nada hace un backup
          de <code>~/.claude.json</code> y <code>settings.json</code>, y no aplica nada sin que
          lo tildes acá.
        </p>
        <button className="btn sm primary" onClick={abrirParaImportar} disabled={busy}>
          Elegir un paquete…
        </button>

        {pkgInfo && plan && (
          <div style={{ marginTop: 14 }}>
            <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
              <span className="chip info">de {pkgInfo.machineLabel}</span>
              <span className="chip">{pkgInfo.platform}</span>
              <span className="chip dim">exportado {fmtDate(pkgInfo.exportedAt)}</span>
            </div>

            {SECCIONES.map((s) => {
              const items = plan[s.id] || [];
              if (!items.length) return null;
              return (
                <div key={s.id} style={{ marginBottom: 12 }}>
                  <div className="dim" style={{ fontSize: 10.5, letterSpacing: 0.5, marginBottom: 5 }}>
                    {s.label.toUpperCase()}
                  </div>
                  {items.map((i) => (
                    <label
                      key={i.id}
                      className="row"
                      style={{ gap: 8, padding: '4px 0', cursor: 'pointer', alignItems: 'flex-start' }}
                    >
                      <input
                        type="checkbox"
                        checked={(seleccion[s.id] || []).includes(i.id)}
                        onChange={() => toggleItem(s.id, i.id)}
                        disabled={i.action === 'igual'}
                        style={{ marginTop: 3 }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="trunc" style={{ display: 'block', fontSize: 12 }} title={i.label}>
                          {i.label}
                        </span>
                        <span className="dim" style={{ fontSize: 11 }}>{i.detail}</span>
                        {i.warning && (
                          <div className="chip bad" style={{ marginTop: 4, whiteSpace: 'normal', display: 'block', fontSize: 10.5 }}>
                            {i.warning}
                          </div>
                        )}
                      </span>
                      <span className={'chip ' + (ACCION_CHIP[i.action] || '')} style={{ fontSize: 10 }}>
                        {ACCION_TXT[i.action] || i.action}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}

            <div className="row" style={{ gap: 8, marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
              <button className="btn sm primary" onClick={aplicar} disabled={busy || !totalSeleccionado}>
                Aplicar {totalSeleccionado} {totalSeleccionado === 1 ? 'cambio' : 'cambios'}
              </button>
              <button className="btn sm" onClick={() => { setPlan(null); setPkgInfo(null); }}>Cancelar</button>
              <span className="dim right" style={{ fontSize: 11 }}>
                Se hace backup automático antes de escribir
              </span>
            </div>
          </div>
        )}

        {resultado && (
          <div style={{ marginTop: 14 }}>
            <div className="chip on" style={{ marginBottom: 8 }}>
              {resultado.hecho.length} {resultado.hecho.length === 1 ? 'cosa aplicada' : 'cosas aplicadas'}
            </div>
            <div className="dim mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
              {resultado.hecho.map((h, i) => <div key={i}>· {h}</div>)}
            </div>
            {resultado.errores.length > 0 && (
              <div className="chip bad" style={{ marginTop: 8, display: 'block', whiteSpace: 'normal' }}>
                {resultado.errores.join(' · ')}
              </div>
            )}
            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <span className="dim" style={{ fontSize: 11.5 }}>Backup en {resultado.backupPath}</span>
              <button className="btn sm" onClick={() => window.cockpit.openPath(resultado.backupPath)}>Abrir</button>
            </div>
            <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
              Reiniciá Claude Code para que tome los MCPs y los hooks nuevos.
            </div>
          </div>
        )}
      </div>

      <div className="card dim" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: 'var(--text)' }}>Tres cosas que el paquete NO hace, a propósito.</b><br />
        No marca ningún proyecto como confiado: aceptar una carpeta es una decisión de seguridad
        que tomás vos en Claude Code, no algo que herede un archivo que te pasaron.<br />
        No lleva los índices del grafo (hasta 17 MB y atados a rutas de este disco): lleva la receta
        para regenerarlos donde se importe.<br />
        No reescribe el contenido de tus scripts ni de tus memorias. Si mencionan rutas de otra
        máquina te avisa en la vista previa, pero tocarlos por su cuenta sería peor.
      </div>
    </div>
  );
}
