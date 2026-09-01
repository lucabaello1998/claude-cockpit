'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { P, readJSON, statSafe } = require('./sources/paths.cjs');
const transcripts = require('./sources/transcripts.cjs');

// En que estado esta la maquina antes de poder mostrar algo.
//
// La app daba por hecho que Claude Code estaba instalado y usado. Si no lo
// estaba, no rompia: mostraba todos los paneles vacios, que es peor, porque
// parece que la app esta rota y no que falta el paso de antes.
//
// Una aclaracion que importa: esta app NO puede loguearte. El login de Claude
// Code es un OAuth que corre el CLI `claude`, y el token queda en
// ~/.claude/.credentials.json. Lo unico honesto es detectar en que punto estas
// y decirte exactamente que hacer.

const ESTADOS = {
  SIN_CLAUDE: 'sin-claude',   // no hay ni carpeta ni config: nunca se instalo o nunca se corrio
  SIN_SESION: 'sin-sesion',   // esta instalado pero no iniciaste sesion
  SIN_DATOS: 'sin-datos',     // todo bien, pero todavia no usaste Claude Code
  LISTO: 'listo',
};

// Busca el CLI en el PATH. Sirve para distinguir "no lo instalaste" de
// "lo instalaste pero nunca lo corriste".
function buscarCli() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['claude'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !String(stdout || '').trim()) return resolve(null);
      resolve(String(stdout).trim().split(/\r?\n/)[0]);
    });
  });
}

async function estado() {
  const hayCarpeta = !!statSafe(P.CLAUDE_DIR);
  const hayConfig = !!statSafe(P.CLAUDE_JSON);
  const cli = await buscarCli();

  if (!hayCarpeta && !hayConfig) {
    return {
      estado: ESTADOS.SIN_CLAUDE,
      cli,
      titulo: cli
        ? 'Claude Code está instalado, pero nunca se ejecutó en esta máquina'
        : 'No encontré Claude Code en esta máquina',
      detalle: cli
        ? 'El comando existe en ' + cli + ', pero todavía no creó su carpeta de configuración. ' +
          'Abrí una terminal, ejecutá `claude` una vez y volvé acá.'
        : 'Claude Cockpit no reemplaza a Claude Code: lo lee. Primero hay que instalarlo y usarlo un rato.',
      pasos: cli
        ? [{ texto: 'Ejecutá `claude` en una terminal e iniciá sesión', comando: 'claude' }]
        : [
          { texto: 'Instalá Claude Code', comando: 'npm install -g @anthropic-ai/claude-code' },
          { texto: 'Ejecutalo una vez e iniciá sesión con tu cuenta', comando: 'claude' },
        ],
      enlace: 'https://docs.claude.com/en/docs/claude-code/overview',
    };
  }

  const credenciales = !!statSafe(path.join(P.CLAUDE_DIR, '.credentials.json'));
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const cuenta = cj.oauthAccount || cj.account || null;

  if (!credenciales && !cuenta) {
    return {
      estado: ESTADOS.SIN_SESION,
      cli,
      titulo: 'Claude Code está instalado pero sin sesión iniciada',
      detalle: 'Esta app no puede iniciarte sesión: el login lo hace el propio Claude Code, ' +
        'y guarda el token en tu carpeta. Ejecutá `claude` en una terminal, entrá con tu cuenta, ' +
        'y volvé acá.',
      pasos: [{ texto: 'Iniciá sesión desde el CLI', comando: 'claude' }],
      enlace: 'https://docs.claude.com/en/docs/claude-code/overview',
    };
  }

  let cuantos = 0;
  try { cuantos = transcripts.listTranscriptFiles().length; } catch { cuantos = 0; }

  if (!cuantos) {
    return {
      estado: ESTADOS.SIN_DATOS,
      cli,
      titulo: 'Todo listo, pero todavía no hay conversaciones para mostrar',
      detalle: 'Claude Code está instalado y con sesión iniciada, pero no encontré ningún ' +
        'transcript en ' + P.projects + '. Usalo un rato en algún proyecto y volvé: ' +
        'la app se actualiza sola cuando aparecen archivos nuevos.',
      pasos: [{ texto: 'Abrí un proyecto y trabajá un rato', comando: 'claude' }],
      enlace: null,
    };
  }

  return { estado: ESTADOS.LISTO, cli, transcripts: cuantos };
}

module.exports = { estado, ESTADOS };
