'use strict';

// Auto-update contra los releases de GitHub.
//
// Dos decisiones que valen mas que el codigo:
//
// 1. NO se instala solo. La app entera funciona asi: nada se escribe sin que lo
//    confirmes. Que se reinicie sola para actualizarse mientras estas mirando
//    una conversacion seria justo lo contrario. Aca avisa, y vos decidis cuando
//    descargar y cuando reiniciar.
//
// 2. En desarrollo queda inerte. electron-updater tira si no encuentra el
//    archivo de metadatos que arma el empaquetador, y esa excepcion no dice
//    nada util: se corta antes y se explica.
//
// El instalador NO esta firmado. Windows va a mostrar el aviso de SmartScreen
// la primera vez, igual que con la instalacion inicial. Firmarlo cuesta plata
// y un certificado a nombre de alguien; hasta que eso pase, es honesto decirlo
// en vez de que sorprenda.

let autoUpdater = null;
let estado = {
  soportado: false,
  motivo: null,
  buscando: false,
  disponible: null,      // { version, notas, fecha }
  descargando: false,
  progreso: 0,
  descargada: false,
  error: null,
  ultimaBusqueda: null,
};

let avisar = () => {};

function iniciar(app, onCambio) {
  avisar = typeof onCambio === 'function' ? onCambio : () => {};

  if (!app.isPackaged) {
    estado.soportado = false;
    estado.motivo = 'El actualizador solo corre en la app instalada. En desarrollo no hay nada que actualizar.';
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    estado.soportado = false;
    estado.motivo = 'No se pudo cargar el actualizador: ' + e.message;
    return;
  }

  estado.soportado = true;
  autoUpdater.autoDownload = false;          // se descarga cuando vos digas
  autoUpdater.autoInstallOnAppQuit = false;  // y se instala cuando vos digas

  autoUpdater.on('error', (e) => {
    estado.buscando = false;
    estado.descargando = false;
    estado.error = String((e && e.message) || e).slice(0, 300);
    avisar(publico());
  });

  autoUpdater.on('update-available', (info) => {
    estado.buscando = false;
    estado.error = null;
    estado.disponible = {
      version: info.version,
      fecha: info.releaseDate || null,
      notas: notasDe(info.releaseNotes),
    };
    avisar(publico());
  });

  autoUpdater.on('update-not-available', () => {
    estado.buscando = false;
    estado.disponible = null;
    estado.error = null;
    avisar(publico());
  });

  autoUpdater.on('download-progress', (p) => {
    estado.descargando = true;
    estado.progreso = Math.round(p.percent || 0);
    avisar(publico());
  });

  autoUpdater.on('update-downloaded', () => {
    estado.descargando = false;
    estado.progreso = 100;
    estado.descargada = true;
    avisar(publico());
  });

  // Una busqueda al arrancar, con demora: que la ventana termine de cargar
  // antes de pedirle algo a la red.
  setTimeout(() => { buscar().catch(() => {}); }, 8000);
}

// Las notas del release vienen como string (HTML) o como lista de versiones.
// Se pasan a texto: el renderer no interpreta HTML de ningun lado.
function notasDe(n) {
  if (!n) return '';
  const crudo = Array.isArray(n)
    ? n.map((x) => (typeof x === 'string' ? x : (x && x.note) || '')).join('\n')
    : String(n);
  return crudo
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function publico() {
  return { ...estado, version: require('../../package.json').version };
}

async function buscar() {
  if (!estado.soportado || !autoUpdater) return publico();
  estado.buscando = true;
  estado.error = null;
  estado.ultimaBusqueda = Date.now();
  avisar(publico());
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    estado.buscando = false;
    estado.error = String((e && e.message) || e).slice(0, 300);
  }
  avisar(publico());
  return publico();
}

async function descargar() {
  if (!estado.soportado || !autoUpdater) throw new Error(estado.motivo || 'No disponible.');
  if (!estado.disponible) throw new Error('No hay ninguna versión nueva para descargar.');
  estado.descargando = true;
  estado.progreso = 0;
  estado.error = null;
  avisar(publico());
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    estado.descargando = false;
    estado.error = String((e && e.message) || e).slice(0, 300);
    avisar(publico());
    throw e;
  }
  return publico();
}

// Cierra la app y corre el instalador. Es lo unico que reinicia sin preguntar
// otra vez, porque ya lo pediste vos apretando el boton.
function instalar() {
  if (!estado.descargada || !autoUpdater) throw new Error('Todavía no está descargada.');
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

module.exports = { iniciar, buscar, descargar, instalar, publico, notasDe };
