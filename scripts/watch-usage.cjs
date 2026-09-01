'use strict';
// Vigila los medidores de uso y avisa por stdout SOLO cuando cruza un umbral,
// para no llenar de ruido. Pensado para correr en segundo plano durante una
// auditoria larga.
//
//   node scripts/watch-usage.cjs [intervaloMin]
//
// Emite una linea cuando:
//   - la ventana de 5h pasa 90%  -> conviene esperar el reset (~horas)
//   - la ventana de 7d pasa 95%  -> parar y avisar (el reset son ~dias)
//   - despues de haber cruzado, vuelve a bajar -> ya se puede seguir

const { fetchUsage } = require('../src/main/sources/liveUsage.cjs');

const INTERVALO = Math.max(2, Number(process.argv[2]) || 10) * 60 * 1000;
// Dos niveles: el pre-aviso da tiempo a documentar el traspaso antes de que
// el corte real llegue.
const PREAVISO = { five_hour: 85, seven_day: 93 };
const UMBRAL = { five_hour: 90, seven_day: 95 };

const cruzado = { five_hour: false, seven_day: false };
const avisado = { five_hour: false, seven_day: false };

function minutosHasta(iso) {
  if (!iso) return null;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

function fmtEspera(min) {
  if (min == null) return 'sin fecha de reinicio';
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

async function tick() {
  let r;
  try {
    r = await fetchUsage();
  } catch (e) {
    // Un fallo puntual de red no es motivo para matar la vigilancia.
    return;
  }
  for (const m of r.meters) {
    const umbral = UMBRAL[m.key];
    if (umbral == null) continue;
    const espera = fmtEspera(minutosHasta(m.resetsAt));
    const pre = PREAVISO[m.key];
    if (m.utilization >= umbral && !cruzado[m.key]) {
      cruzado[m.key] = true;
      console.log(`ALERTA ${m.key} ${m.utilization}% (corte en ${umbral}%) reinicia en ${espera}`);
    } else if (m.utilization >= pre && !avisado[m.key]) {
      avisado[m.key] = true;
      console.log(`PREAVISO ${m.key} ${m.utilization}% (corte en ${umbral}%) reinicia en ${espera} — hora de documentar el traspaso`);
    } else if (m.utilization < umbral - 5 && cruzado[m.key]) {
      cruzado[m.key] = false;
      avisado[m.key] = false;
      console.log(`OK ${m.key} bajo a ${m.utilization}%: se puede seguir`);
    }
  }
}

console.log(`vigilando cada ${INTERVALO / 60000} min · preaviso 5h ${PREAVISO.five_hour}% / 7d ${PREAVISO.seven_day}% · corte 5h ${UMBRAL.five_hour}% / 7d ${UMBRAL.seven_day}%`);
tick();
setInterval(tick, INTERVALO);
