'use strict';
const { spawn } = require('child_process');
const { P, readJSON } = require('./sources/paths.cjs');

// Cliente MCP por stdio, generico: sirve para cualquier servidor configurado en
// ~/.claude.json, no solo para el del grafo. Se extrajo de mcpGraph.cjs cuando
// hizo falta hablarle tambien a Azure DevOps.
//
// Protocolo: JSON-RPC 2.0, un mensaje por linea. El proceso se levanta a
// demanda y se apaga solo tras un rato sin uso.

const SALTO = String.fromCharCode(10);
const IDLE_MS = 180000;
const CALL_TIMEOUT_MS = 60000;

// Busca la definicion de un servidor.
//
// SOLO mira el alcance de usuario y .mcp.json. Antes tambien recorria los
// mcpServers de CUALQUIER proyecto registrado, asi que abrir un panel podia
// levantar un binario definido por un repo ajeno, incluso uno que estuviera
// deshabilitado en Claude Code. Un servidor de proyecto solo se usa si el
// proyecto lo tiene habilitado explicitamente y se pide con su ruta.
function definicionDe(nombre, proyecto) {
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  if ((cj.mcpServers || {})[nombre]) return cj.mcpServers[nombre];
  const f = readJSON(P.mcpJson, {}) || {};
  if ((f.mcpServers || {})[nombre]) return f.mcpServers[nombre];

  if (proyecto) {
    const pr = (cj.projects || {})[proyecto];
    if (pr && pr.mcpServers && pr.mcpServers[nombre]) {
      const apagados = pr.disabledMcpjsonServers || [];
      if (!apagados.includes(nombre)) return pr.mcpServers[nombre];
    }
  }
  return null;
}

// Un argumento que pueda romper el entrecomillado de cmd.exe no se manda.
// `%VAR%` se expande incluso dentro de comillas dobles y no hay forma
// confiable de escaparlo en la linea de comandos.
function argumentoSeguro(a) {
  const s = String(a == null ? '' : a);
  return !/["%\r\n\u0000]/.test(s);
}

// Validacion del comando. Es mas delicada de lo que parece:
//
//   - Los operadores de cmd.exe (& | < > ^ % ") no pueden aparecer nunca.
//   - Un espacio tampoco alcanza con entrecomillarlo: probado, `"cmd /c echo
//     X"` SI ejecuta, porque cmd /s despoja las comillas exteriores y termina
//     leyendo `cmd` con `/c echo X` como argumentos. O sea: entrecomillar no
//     contiene un comando con espacios.
//   - Pero rechazar todo espacio deja afuera "C:\Program Files\nodejs\node.exe",
//     que es la instalacion por defecto de Node en Windows (y a cualquiera con
//     nombre y apellido en la carpeta de usuario, o con OneDrive corporativo).
//
// La salida es distinguir un NOMBRE de un ARCHIVO: si tiene espacios, tiene que
// ser una ruta que exista en el disco. `cmd /c echo X` no es un archivo; el
// node.exe de Program Files si. Un nombre pelado (npx, uvx) va sin comillas,
// porque `"npx"` arranca pero despues no encuentra npm-prefix.js: el shim de
// npm calcula su propia ruta distinto segun como lo invoques.
const OPERADORES_CMD = /["&|<>^%\r\n\u0000]/;

function comandoSeguro(c) {
  const s = String(c == null ? '' : c);
  if (!s || OPERADORES_CMD.test(s)) return false;
  if (!/[\s()]/.test(s)) return true;        // nombre pelado o ruta sin espacios
  // Con espacios o parentesis: solo se acepta si es un archivo de verdad.
  try { return require('fs').statSync(s).isFile(); } catch { return false; }
}

function comandoParaLinea(c) {
  const s = String(c);
  return /[\s()]/.test(s) ? '"' + s + '"' : s;
}

// Entrecomilla un argumento para la CRT de Windows. Los backslashes que
// quedan pegados a la comilla de cierre hay que duplicarlos: si no, `\"` se
// lee como comilla literal, la de cierre desaparece y el argumento siguiente
// se mete adentro del anterior. Pasa con cualquier ruta terminada en `\`,
// que es como se suele configurar server-filesystem.
function citar(a) {
  return '"' + String(a).replace(/(\\+)$/, '$1$1') + '"';
}

// Arma la linea para cmd.exe: comando (ya validado) y cada argumento entre
// comillas, para que un "&&" viaje como texto y no como operador.
function lineaWindows(command, args) {
  return [comandoParaLinea(command)].concat(args.map(citar)).join(' ');
}

function servidoresDisponibles() {
  const vistos = new Map();
  const cj = readJSON(P.CLAUDE_JSON, {}) || {};
  const sumar = (n, d, alcance, proyecto) => {
    if (/^claude\.ai /i.test(n) || vistos.has(n)) return;
    vistos.set(n, { name: n, alcance, proyecto: proyecto || null, command: d.command || d.url || null });
  };
  for (const [n, d] of Object.entries(cj.mcpServers || {})) sumar(n, d, 'usuario');
  const f = readJSON(P.mcpJson, {}) || {};
  for (const [n, d] of Object.entries(f.mcpServers || {})) sumar(n, d, '.mcp.json');
  for (const [ruta, pr] of Object.entries(cj.projects || {})) {
    for (const [n, d] of Object.entries((pr && pr.mcpServers) || {})) sumar(n, d, 'proyecto', ruta);
  }
  return [...vistos.values()];
}

class McpClient {
  // `proyecto` es la ruta del proyecto que define el servidor, cuando no es de
  // alcance de usuario. Hay que pasarla a proposito: sin ella, un servidor
  // declarado por un repo cualquiera no se resuelve (ver definicionDe).
  constructor(nombre, proyecto) {
    this.nombre = nombre;
    this.proyecto = proyecto || null;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.idleTimer = null;
    this.herramientas = null;
    this.ultimoError = '';
  }

  disponible() { return !!definicionDe(this.nombre, this.proyecto); }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.proc) { try { this.proc.kill(); } catch { /* ya murio */ } this.proc = null; }
    this.ready = null;
    this.herramientas = null;
    // Sin el stderr, "se cerró" no dice nada: es el unico rastro de por que.
    const pista = String(this.ultimoError || '').trim().split(SALTO).filter(Boolean).slice(-4).join(' · ').slice(0, 300);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);   // si no, queda un timer de 60 s por llamada en vuelo
      p.reject(new Error('El servidor MCP se cerró.' + (pista ? ' Dijo: ' + pista : '')));
    }
    this.pending.clear();
    this.buf = '';
  }

  _start() {
    if (this.ready) return this.ready;
    const def = definicionDe(this.nombre, this.proyecto);
    if (!def) return Promise.reject(new Error(`No hay un servidor MCP llamado "${this.nombre}".`));
    if (!def.command) return Promise.reject(new Error(`"${this.nombre}" es remoto: por ahora solo se soportan servidores locales.`));

    this.ready = new Promise((resolve, reject) => {
      const args = def.args || [];
      // En Windows hace falta shell para resolver npx/npm (son .cmd y
      // CreateProcess no los ejecuta directo). Pasando `args` con shell:true,
      // cmd.exe reinterpreta el arreglo: un "&&" en un argumento ejecuta un
      // segundo programa. Se arma la linea a mano, con cada parte entre
      // comillas, y se rechaza lo que no se pueda entrecomillar.
      const usaShell = process.platform === 'win32';
      if (usaShell && !comandoSeguro(def.command)) {
        return reject(new Error(
          'El comando de "' + this.nombre + '" tiene caracteres que cmd.exe interpretaría ' +
          '(espacios, &, |, %...). Usá la ruta corta del ejecutable.'
        ));
      }
      if (usaShell && !args.every(argumentoSeguro)) {
        return reject(new Error(
          'La definición de "' + this.nombre + '" tiene argumentos que no se pueden entrecomillar (comillas o %).'
        ));
      }

      let proc;
      try {
        proc = usaShell
          ? spawn(lineaWindows(def.command, args), {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env: Object.assign({}, process.env, def.env || {}),
          })
          : spawn(def.command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, def.env || {}),
          });
      } catch (e) {
        return reject(new Error('No se pudo iniciar ' + this.nombre + ': ' + e.message));
      }
      this.proc = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => this._onData(c));
      // El stderr del servidor son logs, pero cuando no arranca es la unica
      // pista de por que. Se guardan las ultimas lineas para el mensaje de error.
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c) => {
        this.ultimoError = (this.ultimoError + c).slice(-1200);
      });
      proc.on('error', (e) => { this.stop(); reject(new Error('Falló ' + this.nombre + ': ' + e.message)); });
      proc.on('exit', () => this.stop());

      this._rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-cockpit', version: '1.0.0' },
      })
        .then(() => { this._notify('notifications/initialized'); resolve(); })
        .catch((e) => {
          // Sin esto el proceso queda huerfano (no hay idleTimer, porque
          // _touch() nunca llega a correr) y this.ready se queda rechazada:
          // arreglabas la definicion del servidor y la app repetia el mismo
          // error hasta que la reiniciaras.
          this.stop();
          reject(e);
        });
    });
    return this.ready;
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'error del servidor MCP'));
      else p.resolve(msg.result);
    }
  }

  _notify(method, params) {
    if (this.proc) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('El servidor MCP no está corriendo.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const pista = String(this.ultimoError || '').trim().split('\n').slice(-3).join(' · ').slice(0, 240);
        reject(new Error('El servidor MCP no respondió a tiempo.' + (pista ? ' Dijo: ' + pista : '')));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  async tools() {
    await this._start();
    this._touch();
    if (this.herramientas) return this.herramientas;
    const r = await this._rpc('tools/list', {});
    this.herramientas = (r && r.tools) || [];
    return this.herramientas;
  }

  async call(tool, args) {
    await this._start();
    this._touch();
    const res = await this._rpc('tools/call', { name: tool, arguments: args || {} });
    // El protocolo marca los errores de la herramienta con isError, no con un
    // error de JSON-RPC. Sin mirarlo, "token vencido" se veia igual que
    // "no hay resultados".
    if (res && res.isError) {
      const texto = (res.content || [])
        .filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim();
      throw new Error(texto ? texto.slice(0, 300) : 'La herramienta ' + tool + ' devolvió un error.');
    }
    return desempaquetar(res);
  }
}

// Las respuestas vienen como content[{type:'text', text:'<json o texto>'}].
function desempaquetar(result) {
  if (!result) return null;
  const bloques = result.content || [];
  const texto = bloques.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  if (!texto) return result.structuredContent || result;
  try { return JSON.parse(texto); } catch { return { text: texto }; }
}

// Un cliente por servidor. La clave incluye el proyecto: el mismo nombre
// puede estar definido en dos lados y no son el mismo servidor.
const pool = new Map();
function cliente(nombre, proyecto) {
  const clave = nombre + '|' + (proyecto || '');
  if (!pool.has(clave)) pool.set(clave, new McpClient(nombre, proyecto));
  return pool.get(clave);
}

// Ubica un servidor por nombre entre los declarados, devolviendo tambien de
// donde sale. Sirve para que la UI pueda decir "lo define tal proyecto" en vez
// de levantarlo en silencio.
function ubicar(nombre) {
  return servidoresDisponibles().find((s) => s.name === nombre) || null;
}
function detenerTodos() {
  for (const c of pool.values()) c.stop();
  pool.clear();
}

module.exports = { cliente, ubicar, comandoSeguro, comandoParaLinea, argumentoSeguro, citar, lineaWindows, detenerTodos, servidoresDisponibles, definicionDe, McpClient };
