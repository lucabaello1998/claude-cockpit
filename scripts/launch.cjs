'use strict';
// Claude Code (y cualquier app Electron) deja ELECTRON_RUN_AS_NODE=1 en el
// entorno de las terminales que abre. Si arrancas la app desde ahi, Electron
// corre como Node pelado y require('electron') devuelve un string en vez de
// la API: la app revienta con "Cannot read properties of undefined".
// Este launcher limpia la variable antes de arrancar.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, [path.join(__dirname, '..')].concat(process.argv.slice(2)), {
  stdio: 'inherit',
  env,
});
child.on('close', (code) => process.exit(code == null ? 0 : code));
