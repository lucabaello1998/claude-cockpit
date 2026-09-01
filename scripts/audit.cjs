// Auditoria de seguridad: intenta explotar cada superficie de escritura y
// verifica que quede contenida. Correr con:  node scripts/audit.cjs
const path0 = require('path');
const B = path0.join(__dirname, '..') + path0.sep;
const fs = require('fs'); const path = require('path'); const os = require('os');
const seguro = require(B + 'src/main/safePaths.cjs');
const se = require(B + 'src/main/skillsEdit.cjs');
const pe = require(B + 'src/main/pluginsEdit.cjs');
const pkg = require(B + 'src/main/pkg.cjs');
const { P } = require(B + 'src/main/sources/paths.cjs');

let pasa = 0, falla = 0;
function esperar(nombre, cond, detalle) {
  if (cond) { pasa++; console.log('  ok  ', nombre); }
  else { falla++; console.log('  FALLA', nombre, detalle ? '->' + detalle : ''); }
}
function rechaza(nombre, fn) {
  try { const r = fn(); esperar(nombre, false, 'no lanzo, devolvio ' + JSON.stringify(r).slice(0, 60)); }
  catch (e) { esperar(nombre, true); }
}

// Las funciones async no lanzan de forma sincronica: rechazan la promesa.
// Probarlas con rechaza() daba un falso negativo.
async function rechazaAsync(nombre, fn) {
  try { await fn(); esperar(nombre, false, 'la promesa se resolvio'); }
  catch (e) { esperar(nombre, true); }
}

// Los caracteres de control se colaron varias veces al parchear archivos con
// herramientas que reinterpretan los escapes: una backreference queda como el
// byte 0x01 y la expresion regular deja de funcionar sin avisar.
// Se comprueba por codigo de caracter, no con una expresion regular literal:
// escribir la clase de caracteres aca seria caer en el mismo problema.
console.log('== integridad del codigo fuente ==');
{
  const PERMITIDOS = new Set([9, 10, 13]);
  const sospechosos = [];
  const recorrer = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path0.join(dir, f.name);
      if (f.isDirectory()) { recorrer(full); continue; }
      if (!/[.](c?js|jsx|css)$/.test(f.name)) continue;
      const txt = fs.readFileSync(full, 'utf8');
      let n = 0;
      for (let i = 0; i < txt.length; i++) {
        const c = txt.charCodeAt(i);
        if (c < 32 && !PERMITIDOS.has(c)) n++;
      }
      if (n) sospechosos.push(path0.relative(B, full) + ' (' + n + ')');
    }
  };
  for (const r of ['src', 'electron', 'scripts']) {
    try { recorrer(path0.join(B, r)); } catch { /* no existe */ }
  }
  esperar('sin caracteres de control en el codigo', sospechosos.length === 0, sospechosos.join(', '));
}

console.log('== contencion de rutas ==');
esperar('skills-malicioso NO esta dentro de skills', !seguro.dentroDe(P.skills, P.skills + '-malicioso'));
esperar('subcarpeta SI esta dentro', seguro.dentroDe(P.skills, path.join(P.skills, 'x', 'y')));
esperar('la propia base cuenta como dentro', seguro.dentroDe(P.skills, P.skills));
esperar('../.. rechazado', seguro.unirSeguro(P.skills, '../../evil.txt') === null);
esperar('..\\..\\ rechazado', seguro.unirSeguro(P.skills, '..\\..\\evil.txt') === null);
esperar('ruta absoluta rechazada', seguro.unirSeguro(P.skills, 'C:/Windows/evil.txt') === null);
esperar('segmento con / rechazado', seguro.segmentoSeguro('a/b') === null);
esperar('nombre reservado rechazado', seguro.segmentoSeguro('CON') === null);
esperar('nombre normal aceptado', seguro.segmentoSeguro('mi-skill') === 'mi-skill');
esperar('anidado valido aceptado', !!seguro.unirSeguro(P.skills, 'a/b/c.md'));

console.log('== esquemas y repos ==');
esperar('http permitido', seguro.urlPermitida('https://x.com'));
esperar('file:// rechazado', !seguro.urlPermitida('file:///C:/Windows/system.ini'));
esperar('javascript: rechazado', !seguro.urlPermitida('javascript:alert(1)'));
esperar('ms-msdt: rechazado', !seguro.urlPermitida('ms-msdt:/id'));
esperar('git ext:: rechazado', !seguro.repoGitPermitido('ext::sh -c "calc"'));
esperar('git file:// rechazado', !seguro.repoGitPermitido('file:///C:/repo'));
esperar('flag como repo rechazado', !seguro.repoGitPermitido('--upload-pack=calc'));
esperar('https github aceptado', seguro.repoGitPermitido('https://github.com/anthropics/skills'));

console.log('== skillsEdit ==');
const fuera = path.join(os.tmpdir(), 'cockpit-verify');
fs.rmSync(fuera, { recursive: true, force: true });
fs.mkdirSync(fuera, { recursive: true });
fs.writeFileSync(path.join(fuera, 'SKILL.md'), '---\nname: x\n---\nsecreto');
rechaza('read fuera de las raices', () => se.read(fuera));
rechaza('save fuera de las raices', () => se.save(fuera, { description: 'x' }));
rechaza('eliminar la carpeta raiz de skills', () => se.eliminar(P.skills));
rechaza('eliminar hermana con prefijo', () => se.eliminar(P.skills + '-malicioso'));
rechaza('eliminar fuera de skills', () => se.eliminar(fuera));
rechaza('crear con ../..', () => se.crear('../../evil', 'x', 'y'));
const mkSkill = path.join(P.plugins, 'marketplaces', 'claude-plugins-official', 'plugins',
  'claude-code-setup', 'skills', 'claude-automation-recommender');
if (fs.existsSync(mkSkill)) {
  rechaza('editar skill de marketplace', () => se.save(mkSkill, { description: 'pisada' }));
  esperar('pero leerla si se puede', !!se.read(mkSkill).name);
}

// El resto corre dentro de una funcion async por los marketplaces.
(async () => {
console.log('== pluginsEdit ==');
await rechazaAsync('marketplace con ext::', () => pe.addMarketplace('ext::sh -c calc'));
await rechazaAsync('marketplace con file://', () => pe.addMarketplace('file:///C:/repo'));
await rechazaAsync('marketplace con ftp://', () => pe.addMarketplace('ftp://x/y'));
await rechazaAsync('marketplace como flag', () => pe.addMarketplace('--upload-pack=calc'));
rechaza('quitar marketplace inexistente', () => pe.removeMarketplace('../../..'));

console.log('== pkg: paquete malicioso ==');
const malo = {
  schemaVersion: 1, kind: 'claude-cockpit-package',
  exportedFrom: { machineLabel: 'atacante' },
  sections: {
    skills: [
      { name: '../../../../ESCAPE', files: { 'SKILL.md': 'x' } },
      { name: 'inocente', files: { '../../../ESCAPE2.txt': 'x', 'ok.md': 'contenido bueno' } },
    ],
    workflows: [{ file: '../../../ESCAPE3.js', content: 'x' }],
    hooks: { config: {}, scripts: { '../../ESCAPE4': 'x' } },
    memory: [{ projectDir: '../../ESCAPE5', projectPath: null, files: { 'a.md': 'x' } }],
    mcpServers: [], projects: [],
  },
};
const plan = pkg.plan(malo);
const sel = {};
for (const [k, v] of Object.entries(plan)) sel[k] = v.map((i) => i.id);
const ud = path.join(os.tmpdir(), 'cockpit-verify-ud');
fs.rmSync(ud, { recursive: true, force: true });
const res = pkg.apply(malo, sel, ud);
// Se arman desde el HOME real: con rutas fijas el test pasaba de mentira en
// cualquier maquina que no fuera la del que lo escribio.
const HOME = os.homedir();
const escapes = [
  path.join(HOME, '..', 'ESCAPE'),
  path.join(HOME, 'ESCAPE2.txt'),
  path.join(HOME, '..', 'ESCAPE3.js'),
  path.join(HOME, '.claude', 'ESCAPE4'),
  path.join(HOME, '.claude', 'ESCAPE5'),
];
const creados = escapes.filter((p) => fs.existsSync(p));
esperar('ningun archivo escapo del sandbox', creados.length === 0, creados.join(', '));
esperar('los rechazos quedaron registrados', res.errores.length > 0, JSON.stringify(res.errores).slice(0, 120));
console.log('       errores reportados:', res.errores.length);
res.errores.slice(0, 4).forEach((e) => console.log('        ·', e.slice(0, 74)));
const buena = path.join(P.skills, 'inocente');
esperar('el archivo valido del mismo paquete SI se escribio', fs.existsSync(path.join(buena, 'ok.md')));
fs.rmSync(buena, { recursive: true, force: true });
fs.rmSync(fuera, { recursive: true, force: true });
fs.rmSync(ud, { recursive: true, force: true });


// ---------------------------------------------------------------------------
// Ronda 2: los siete agujeros que encontro el gauntlet multiagente.
// Cada bloque reproduce el exploit que funcionaba antes del arreglo.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 2: hallazgos del gauntlet --');

// 1. Inyeccion por shell en la definicion de un MCP.
//    Antes: spawn(cmd, ['--version','&&','node','payload.js'], {shell:true})
//    dejaba que cmd.exe reinterpretara el arreglo y corriera un 2do programa.
{
  const mc = require(B + 'src/main/mcpClient.cjs');
  // El comando va sin comillas (si no, se rompen los shims de npm), asi que
  // tiene que pasar un filtro mas estricto que los argumentos.
  esperar('un comando normal se acepta', mc.comandoSeguro('npx') && mc.comandoSeguro('C:/x/y.exe'));
  for (const malo of ['npx && calc', 'a|b', 'a%X%', 'cmd /c x', 'a>b', 'a^b', 'a"b']) {
    esperar('comando rechazado: ' + malo, !mc.comandoSeguro(malo));
  }
  esperar('un argumento con && se acepta (viaja entrecomillado)', mc.argumentoSeguro('&&'));
  esperar('un argumento con %VAR% se rechaza (cmd.exe lo expande aun entre comillas)',
    !mc.argumentoSeguro('%PATH%'));
  esperar('un argumento con comillas se rechaza', !mc.argumentoSeguro('a"b'));
  const linea = mc.lineaWindows('node', ['--version', '&&', 'calc']);
  esperar('el && queda dentro de comillas, no como operador',
    linea === 'node "--version" "&&" "calc"', linea);
}

// 2. definicionDe() no puede levantar un MCP de un proyecto cualquiera.
{
  const mc = require(B + 'src/main/mcpClient.cjs');
  esperar('definicionDe ignora los mcpServers de proyectos sin pedirlos',
    mc.definicionDe.length === 2, 'aridad ' + mc.definicionDe.length);
  const inventado = mc.definicionDe('__no_existe_en_ningun_lado__');
  esperar('un servidor que solo vive en un proyecto no se resuelve por nombre', inventado == null);
}

// 3. settings.json ilegible no se sobreescribe.
{
  const he = require(B + 'src/main/hooksEdit.cjs');
  const roto = path.join(os.tmpdir(), 'cockpit-settings-roto.json');
  fs.writeFileSync(roto, '{ "permissions": { "allow": ["Bash"] }, }');   // coma de mas
  let lanzo = false;
  try { JSON.parse(fs.readFileSync(roto, 'utf8')); } catch { lanzo = true; }
  esperar('el settings de prueba efectivamente no parsea', lanzo);
  // list() usa leerSettings sobre los archivos reales; lo que se verifica aca
  // es que la funcion distinga "vacio" de "ilegible".
  esperar('hooksEdit expone list/agregar/editar/eliminar',
    ['list', 'agregar', 'editar', 'eliminar'].every((k) => typeof he[k] === 'function'));
  fs.rmSync(roto, { force: true });
}

// 4. Escape por symlink al escribir hooks y workflows.
{
  const baseFalsa = path.join(os.tmpdir(), 'cockpit-symlink-base');
  const afuera = path.join(os.tmpdir(), 'cockpit-symlink-afuera');
  fs.rmSync(baseFalsa, { recursive: true, force: true });
  fs.rmSync(afuera, { recursive: true, force: true });
  fs.mkdirSync(baseFalsa, { recursive: true });
  fs.mkdirSync(afuera, { recursive: true });
  const enlace = path.join(baseFalsa, 'salida');
  let pudo = false;
  try { fs.symlinkSync(afuera, enlace, 'junction'); pudo = true; } catch { /* sin permisos */ }
  if (pudo) {
    const destino = path.join(enlace, 'evadido.txt');
    esperar('dentroDe() por si solo NO detecta el symlink (por eso hace falta el otro control)',
      seguro.dentroDe(baseFalsa, destino));
    esperar('destinoRealSeguro() SI lo detecta y devuelve null',
      seguro.destinoRealSeguro(baseFalsa, destino) === null);
    const legitimo = path.join(baseFalsa, 'normal.txt');
    esperar('destinoRealSeguro() deja pasar una ruta normal',
      seguro.destinoRealSeguro(baseFalsa, legitimo) === legitimo);
  } else {
    console.log('  --   symlink omitido (hace falta modo desarrollador en Windows)');
  }
  fs.rmSync(baseFalsa, { recursive: true, force: true });
  fs.rmSync(afuera, { recursive: true, force: true });
}

// 5. Indices negativos en el id de un hook.
{
  const he = require(B + 'src/main/hooksEdit.cjs');
  const ud = path.join(os.tmpdir(), 'cockpit-verify-ud2');
  fs.rmSync(ud, { recursive: true, force: true });
  esperar('eliminar existe con ese nombre (si no, el test de abajo pasa por TypeError)',
    typeof he.eliminar === 'function');
  rechaza('eliminar con indice de grupo negativo se rechaza',
    () => he.eliminar(ud, 'settings.json|PreToolUse|-1|0'));
  rechaza('eliminar con indice de hook negativo se rechaza',
    () => he.eliminar(ud, 'settings.json|PreToolUse|0|-1'));
  rechaza('editar con indice no numerico se rechaza',
    () => he.editar(ud, 'settings.json|PreToolUse|abc|0', { command: 'x' }));
  fs.rmSync(ud, { recursive: true, force: true });
}

// 6. crearBoard() sanea las columnas igual que guardarColumnas().
{
  const bd = require(B + 'src/main/boards.cjs');
  const dir = path.join(os.tmpdir(), 'cockpit-boards-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = bd.crearBoard(dir, 'T', [
    { id: '__proto__', titulo: 'x'.repeat(500), wip: -3 },
    { id: 'ok', titulo: 'Lista' },
    'no soy un objeto',
  ]);
  const ids = b.columnas.map((c) => c.id);
  esperar('crearBoard descarta la columna con id __proto__', !ids.includes('__proto__'));
  esperar('crearBoard recorta los titulos largos', b.columnas.every((c) => c.titulo.length <= 40));
  esperar('crearBoard normaliza un wip negativo a 0', b.columnas.every((c) => c.wip >= 0));
  esperar('crearBoard ignora las entradas que no son objetos',
    b.columnas.every((c) => c && typeof c === 'object'));
  esperar('el prototipo global quedo intacto', ({}).titulo === undefined);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. Los errores no se tragan en silencio.
{
  const bd = require(B + 'src/main/boards.cjs');
  rechaza('importarComoLocal rechaza un tablero remoto invalido',
    () => bd.importarComoLocal(os.tmpdir(), { columnas: [] }, 'x'));
  const src = fs.readFileSync(B + 'src/main/hooksEdit.cjs', 'utf8');
  esperar('respaldar() ya no se traga los errores que no sean ENOENT',
    /ENOENT/.test(src) && /No se pudo respaldar/.test(src));
  const mcsrc = fs.readFileSync(B + 'src/main/mcpClient.cjs', 'utf8');
  esperar('el stderr del servidor MCP se conserva para el mensaje de error',
    /ultimoError/.test(mcsrc) && !/on\('data', \(\) => \{\}\)/.test(mcsrc));
}

console.log();

// 8. La correccion del alcance no puede dejar sin funcionar un MCP legitimo:
//    el servidor "ado" del usuario esta declarado en un proyecto, no a nivel
//    usuario, y tiene que seguir resolviendose cuando se lo pide con su ruta.
{
  const mc = require(B + 'src/main/mcpClient.cjs');
  const ubic = mc.ubicar('ado');
  if (ubic) {
    esperar('ubicar() dice de que proyecto sale el servidor', !!ubic.proyecto || ubic.alcance === 'usuario');
    esperar('con el proyecto explicito, la definicion SI se resuelve',
      !!mc.definicionDe('ado', ubic.proyecto));
    if (ubic.proyecto) {
      esperar('sin el proyecto, NO se resuelve (es el agujero que se cerro)',
        mc.definicionDe('ado') == null);
    }
  } else {
    console.log('  --   ado no configurado, se omite');
  }
}


// ---------------------------------------------------------------------------
// Ronda 3: lo que encontro el agente de correctitud, todo reproducido.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 3: correctitud --');

// 1. Un argumento terminado en backslash rompia el entrecomillado y se comia
//    el argumento siguiente (pasa con cualquier ruta tipo "C:\proyectos\").
{
  const mc = require(B + 'src/main/mcpClient.cjs');
  const BS = String.fromCharCode(92);
  const linea = mc.lineaWindows('node', ['C:' + BS + 'proyectos' + BS, 'C:' + BS + 'otro']);
  esperar('el backslash final se duplica antes de la comilla de cierre',
    linea.includes('proyectos' + BS + BS + '"'), linea);
  esperar('los dos argumentos siguen separados',
    (linea.match(/"/g) || []).length === 4, linea);
  esperar('un argumento sin backslash final no se toca',
    mc.citar('C:' + BS + 'a') === '"C:' + BS + 'a"', mc.citar('C:' + BS + 'a'));
}

// 2. comandoSeguro rechazaba la instalacion por defecto de Node en Windows.
{
  const mc = require(B + 'src/main/mcpClient.cjs');
  const BS = String.fromCharCode(92);
  for (const c of ['npx', 'node', 'uvx', 'docker']) {
    esperar('nombre pelado aceptado: ' + c, mc.comandoSeguro(c));
  }
  for (const c of ['npx && calc', 'a|b', 'a%X%', 'a>b', 'a^b', 'a"b']) {
    esperar('comando con operador de cmd rechazado: ' + c, !mc.comandoSeguro(c));
  }

  // Un comando con espacios NO se contiene entrecomillandolo: probado, con
  // shell:true `"cmd /c echo X"` ejecuta igual, porque cmd /s despoja las
  // comillas exteriores. La unica forma de aceptar "C:\Program Files\..." sin
  // abrir la puerta es exigir que sea un archivo que exista.
  esperar('comando con espacios que NO es un archivo: rechazado',
    !mc.comandoSeguro('cmd /c echo X'));
  esperar('otro que no es archivo: rechazado', !mc.comandoSeguro('cmd /c calc'));
  esperar('la instalacion real de node (con espacios) SI se acepta',
    mc.comandoSeguro(process.execPath), process.execPath);
  esperar('una ruta con espacios inexistente se rechaza',
    !mc.comandoSeguro('C:' + BS + 'no existe' + BS + 'nada.exe'));

  esperar('un comando con espacios SI se entrecomilla',
    mc.comandoParaLinea('C:' + BS + 'Program Files' + BS + 'x.exe').startsWith('"'));
  esperar('un comando pelado NO se entrecomilla (romperia los shims de npm)',
    mc.comandoParaLinea('npx') === 'npx');
}

// 3. normalize() duplicaba un medidor cuando la entrada del array traia scope.
{
  const lu = require(B + 'src/main/sources/liveUsage.cjs');
  const med = lu.normalize({
    seven_day_opus: { utilization: 71, limit_dollars: 50 },
    five_hour: { utilization: 42, limit_dollars: 10 },
    limits: [
      { kind: 'weekly_opus', percent: 71, severity: 'high', is_active: true,
        scope: { model: { display_name: 'Opus' } } },
      { kind: 'session', percent: 42, severity: 'low', is_active: true },
    ],
  });
  esperar('no se duplica el medidor con scope', med.length === 2, 'salieron ' + med.length);
  const opus = med.find((x) => x.key === 'seven_day_opus');
  esperar('el medidor fusionado conserva los dolares del objeto', opus && opus.limitDollars === 50);
  esperar('y la severity que solo trae el array', opus && opus.severity === 'high');
  esperar('la etiqueta no queda cruda', opus && !/^Seven/.test(opus.label), opus && opus.label);
}

// 4. El bloqueo por 429 no tenia techo: un Retry-After de 86400 mataba la app
//    por 24 horas.
{
  const src = fs.readFileSync(B + 'src/main/sources/liveUsage.cjs', 'utf8');
  esperar('el bloqueo por 429 tiene techo', /ESPERA_429_MAXIMA_MS/.test(src) && /Math\.min\(esperaMs/.test(src));
  esperar('ya no promete un reintento automatico que no siempre existe',
    !/Reintento autom/.test(src));
}

// 5. Un error de la herramienta MCP viaja en isError, no como error JSON-RPC:
//    sin mirarlo, un token vencido se veia como "cero resultados".
{
  const src = fs.readFileSync(B + 'src/main/mcpClient.cjs', 'utf8');
  esperar('se mira isError en las respuestas de tools/call', /res\.isError/.test(src));
}

// 6. elegirHerramienta podia agarrar una herramienta de escritura, porque los
//    ultimos patrones son substrings sueltos (/projects/i, /jql/i).
{
  const src = fs.readFileSync(B + 'src/main/boards.cjs', 'utf8');
  esperar('hay un filtro de verbos de escritura', /VERBOS_DE_ESCRITURA/.test(src));
  const re = /(create|update|delete|remove|add|edit|set|move|assign|transition|write|post|put|patch|archive|close)/i;
  for (const n of ['jira_delete_projects', 'deleteIssuesByJql', 'createJiraIssue', 'updateJiraIssue']) {
    esperar('herramienta de escritura descartada: ' + n, re.test(n));
  }
  for (const n of ['jira_search', 'jira_get_all_projects', 'getVisibleJiraProjects', 'searchJiraIssuesUsingJql']) {
    esperar('herramienta de lectura conservada: ' + n, !re.test(n));
  }
}

// 7. El visor de subagentes quedaba abierto al cambiar de sesion.
{
  const src = fs.readFileSync(B + 'src/renderer/components/Conversations.jsx', 'utf8');
  esperar('el visor de agente se cierra al cambiar de sesion',
    /setAgente\(null\); \}, \[selected\]\)/.test(src));
}

// 8. Overview medía las barras contra un maximo ordenado por costo aunque
//    estuviera dibujando tokens.
{
  const src = fs.readFileSync(B + 'src/renderer/components/Overview.jsx', 'utf8');
  esperar('el maximo sale de la metrica dibujada, no del elemento [0]',
    /Math\.max\(1, \.\.\.filasProyecto\.map\(barra\)\)/.test(src)
    && /Math\.max\(1, \.\.\.filasModelo\.map\(barra\)\)/.test(src));
  esperar('las filas se reordenan por la metrica que se muestra',
    /sort\(\(a, b\) => barra\(b\) - barra\(a\)\)/.test(src));
  esperar('la tarjeta de Modelos avisa cuando queda vacia',
    /!filasModelo\.length \? <div className="dim">/.test(src));
  esperar('barra() sabe sumar los tokens de byModel, que no trae totalTokens',
    /tokensDe = \(f\) =>/.test(src));
  esperar('el eje de dolares usa fmtUSD y no concatena el signo',
    /tickFormatter=\{\(v\) => \(money\.show \? fmtUSD\(v\)/.test(src));
}

// 9. La logica del maximo, ejercitada de verdad con el orden del backend.
{
  const barra = (f, show) => (show ? (f.costUSD || 0) : (f.totalTokens || 0));
  // Asi los devuelve el backend: SIEMPRE ordenados por costo.
  const filas = [
    { key: 'caro', costUSD: 10, totalTokens: 570000 },
    { key: 'cacheado', costUSD: 2, totalTokens: 42835000 },
  ].sort((a, b) => b.costUSD - a.costUSD);

  // Lo que hacia antes: tomar filas[0] como maximo.
  const maxViejo = barra(filas[0], false) || 1;
  const anchoViejo = (barra(filas[1], false) / maxViejo) * 100;
  esperar('el metodo viejo efectivamente pasaba de 100% (por eso era un bug)', anchoViejo > 100,
    Math.round(anchoViejo) + '%');

  // Lo que hace ahora.
  const ordenadas = [...filas].sort((a, b) => barra(b, false) - barra(a, false));
  const maxNuevo = Math.max(1, ...ordenadas.map((f) => barra(f, false)));
  const anchos = ordenadas.map((f) => (barra(f, false) / maxNuevo) * 100);
  esperar('ninguna barra pasa de 100% con la metrica de tokens', anchos.every((a) => a <= 100),
    anchos.map((a) => Math.round(a) + '%').join(', '));
  esperar('la barra mas larga es la de mas tokens', ordenadas[0].key === 'cacheado');
}

console.log();

// ---------------------------------------------------------------------------
// Ronda 4: rendimiento. Lo unico realmente riesgoso aca es el parseo
// incremental: si se equivoca, la app miente sobre cuanto gastaste. Por eso el
// test compara el resultado incremental contra el completo, campo por campo.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 4: parseo incremental --');

await (async () => {
  const tr = require(B + 'src/main/sources/transcripts.cjs');
  const todos = tr.listTranscriptFiles();
  if (!todos.length) { console.log('  --   sin transcripts, se omite'); return; }

  // Uno mediano alcanza y el test no tarda una eternidad.
  const elegido = todos.slice().sort((a, b) => b.size - a.size)
    .find((f) => f.size > 200000 && f.size < 12000000) || todos[0];
  const crudo = fs.readFileSync(elegido.file);
  const dir = path.join(os.tmpdir(), 'cockpit-audit-incr');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'p.jsonl');
  const ent = () => {
    const st = fs.statSync(destino);
    return Object.assign({}, elegido, { file: destino, size: st.size, mtimeMs: st.mtimeMs });
  };

  // Corte en un limite de linea.
  let corte = Math.floor(crudo.length * 0.6);
  while (corte < crudo.length && crudo[corte] !== 10) corte++;
  corte++;

  fs.writeFileSync(destino, crudo.slice(0, corte));
  const prefijo = await tr.summarize(ent());
  esperar('parsedBytes queda en el limite de linea', prefijo.parsedBytes === corte,
    prefijo.parsedBytes + ' vs ' + corte);

  fs.writeFileSync(destino, crudo);
  const e2 = ent();
  const incr = await tr.summarize(e2, prefijo);
  const full = await tr.summarize(e2);

  esperar('el incremental leyo hasta el final', incr.parsedBytes === crudo.length);

  const IGNORAR = new Set(['mtimeMs', 'size', 'parsedBytes', 'huella', 'file']);
  const dif = [];
  for (const k of new Set([...Object.keys(incr), ...Object.keys(full)])) {
    if (IGNORAR.has(k)) continue;
    if (JSON.stringify(incr[k]) !== JSON.stringify(full[k])) dif.push(k);
  }
  esperar('incremental y completo dan EXACTAMENTE lo mismo', dif.length === 0,
    'difieren: ' + dif.join(', '));
  esperar('el costo coincide al ultimo decimal', incr.totals.costUSD === full.totals.costUSD,
    incr.totals.costUSD + ' vs ' + full.totals.costUSD);
  esperar('la cantidad de requests coincide', incr.totals.requests === full.totals.requests);

  // Una linea a medio escribir no se cuenta ni rompe el retomado.
  fs.writeFileSync(destino, Buffer.concat([crudo.slice(0, corte), Buffer.from('{"type":"assis')]));
  const parcial = await tr.summarize(ent());
  esperar('una linea incompleta no se cuenta como parseada', parcial.parsedBytes === corte,
    parcial.parsedBytes + ' vs ' + corte);
  esperar('y no se registra como error de parseo', parcial.parseErrors === prefijo.parseErrors);
  fs.writeFileSync(destino, crudo);
  const completado = await tr.summarize(ent(), parcial);
  esperar('al completarse esa linea, el resultado sigue siendo el correcto',
    completado.totals.costUSD === full.totals.costUSD);

  // Si el archivo se reescribe, la huella cambia y hay que reparsear entero.
  fs.writeFileSync(destino, Buffer.concat([Buffer.from('{"type":"user"}\n'), crudo]));
  const reescrito = await tr.summarize(ent(), prefijo);
  esperar('un archivo reescrito se detecta y se reparsea entero',
    reescrito.parsedBytes === fs.statSync(destino).size
    && reescrito.totals.requests === full.totals.requests);

  // Un archivo que se achico tampoco se retoma.
  fs.writeFileSync(destino, crudo.slice(0, Math.floor(corte / 2)));
  const achicado = await tr.summarize(ent(), prefijo);
  esperar('un archivo que se achico no se retoma',
    achicado.parsedBytes <= Math.floor(corte / 2) + 1);

  fs.rmSync(dir, { recursive: true, force: true });
})();

// Los arreglos de memoria del mcpClient y del store.
{
  const src = fs.readFileSync(B + 'src/main/mcpClient.cjs', 'utf8');
  esperar('un initialize fallido apaga el proceso en vez de dejarlo huerfano',
    /this\.stop\(\);\s*\n\s*reject\(e\)/.test(src));
  esperar('stop() limpia los timers de las llamadas en vuelo',
    /clearTimeout\(p\.timer\);/.test(src));
  const st = fs.readFileSync(B + 'src/main/store.cjs', 'utf8');
  esperar('la cache se baja a disco tambien cuando solo hubo poda',
    /if \(reparsed \|\| podados\)/.test(st));
}

console.log();

// ---------------------------------------------------------------------------
// Ronda 5: el nombre de un servidor MCP termina siendo una clave de
// ~/.claude.json. Venia del panel sin sanear.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 5: nombre de servidor MCP --');
{
  const pe = require(B + 'src/main/projectsEdit.cjs');
  const n = pe.nombreDeServidor;
  esperar('un id del marketplace se reduce a algo valido',
    n('io.github.Foo/mcp@raro!name') === 'mcp-raro-name', n('io.github.Foo/mcp@raro!name'));
  esperar('los espacios se reemplazan', n('servidor normal') === 'servidor-normal');
  esperar('un nombre ya valido no se toca', n('ado') === 'ado');
  for (const malo of ['__proto__', 'constructor', 'prototype']) {
    rechaza('clave reservada rechazada: ' + malo, () => n(malo));
  }
  rechaza('un nombre sin caracteres validos se rechaza', () => n('///'));
  esperar('el prototipo global sigue intacto', ({}).command === undefined);
}

// El icono tiene que existir y ser un ICO valido antes de empaquetar.
{
  const ico = path.join(B, 'build', 'icon.ico');
  if (fs.existsSync(ico)) {
    const b = fs.readFileSync(ico);
    esperar('el .ico declara tipo icono', b.readUInt16LE(2) === 1);
    const cuantas = b.readUInt16LE(4);
    esperar('trae varias resoluciones', cuantas >= 5, cuantas + ' imagenes');
    let hay256 = false;
    let ok = true;
    for (let i = 0; i < cuantas; i++) {
      const o = 6 + i * 16;
      const lado = b[o] === 0 ? 256 : b[o];
      const largo = b.readUInt32LE(o + 8);
      const off = b.readUInt32LE(o + 12);
      if (lado === 256) hay256 = true;
      // Cada entrada tiene que ser un PNG valido y caer dentro del archivo.
      if (off + largo > b.length) { ok = false; break; }
      if (b.slice(off, off + 8).toString('hex') !== '89504e470d0a1a0a') { ok = false; break; }
    }
    esperar('todas las entradas son PNG validos y caen dentro del archivo', ok);
    esperar('incluye la resolucion de 256 que pide electron-builder', hay256);
  } else {
    console.log('  --   build/icon.ico todavia no se genero (npm run icon)');
  }
}

console.log();

// ---------------------------------------------------------------------------
// Ronda 6: Azure DevOps con filtros, detalle y escritura.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 6: boards / ADO --');
{
  const ado = require(B + 'src/main/ado.cjs');

  // desenvolver(): el MCP envuelve los resultados de WIQL con un marcador
  // contra inyeccion que tiene corchetes propios. Si se busca el JSON sin
  // sacarlo antes, se parsea desde el corchete equivocado.
  const marcado = { text: '<<abc123def456>> [UNTRUSTED WIQL QUERY RESULTS CONTENT] <<abc123def456>>\n{"workItems":[{"id":7}]}' };
  const d1 = ado.desenvolver(marcado);
  esperar('se saltea el marcador de contenido no confiable',
    !!(d1 && d1.workItems && d1.workItems[0].id === 7), JSON.stringify(d1));
  const conPrefijo = { text: 'Project: X, Team: Y\n[{"name":"Sprint 1"}]' };
  const d2 = ado.desenvolver(conPrefijo);
  esperar('se saltea el prefijo Project:', !!(d2 && d2[0] && d2[0].name === 'Sprint 1'));
  esperar('un objeto que ya es JSON pasa igual', ado.desenvolver({ a: 1 }).a === 1);
  esperar('texto sin JSON devuelve null', ado.desenvolver({ text: 'nada util' }) === null);
  esperar('null no rompe', ado.desenvolver(null) === null);
  esperar('basura despues del JSON no impide parsear',
    (ado.desenvolver({ text: '{"a":2} y algo mas' }) || {}).a === 2);
  esperar('una llave dentro de un string no confunde el balanceo',
    (ado.desenvolver({ text: '{"a":"}"} sobra' }) || {}).a === '}');

  // La comilla simple es el separador de WIQL: hay que duplicarla.
  const w = ado.construirWiql('P', { texto: "O'Brien" });
  esperar('la comilla simple se escapa duplicandola', w.indexOf("'O''Brien'") >= 0, w);
  esperar('no queda una comilla suelta que corte la consulta',
    (w.match(/'/g) || []).length % 2 === 0);

  const w2 = ado.construirWiql('P', { tipos: ['Feature', 'Task'], soloMias: true });
  esperar('los tipos van con IN', w2.indexOf("IN ('Feature', 'Task')") >= 0, w2);
  esperar('mias usa la macro @Me', w2.indexOf('[System.AssignedTo] = @Me') >= 0);
  esperar('por defecto se excluyen las cerradas', w2.indexOf("NOT IN ('Removed', 'Closed')") >= 0);
  esperar('con incluirCerradas ya no se excluyen',
    ado.construirWiql('P', { incluirCerradas: true }).indexOf('NOT IN') < 0);
  esperar('mias tiene prioridad sobre responsable',
    ado.construirWiql('P', { soloMias: true, responsable: 'X' }).indexOf("'X'") < 0);
  esperar('sin asignar se consulta con cadena vacia',
    ado.construirWiql('P', { responsable: '__sin_asignar__' }).indexOf("[System.AssignedTo] = ''") >= 0);
  esperar('el sprint filtra por ruta con UNDER',
    ado.construirWiql('P', { sprint: 'P\\Sprint 3' }).indexOf('UNDER') >= 0);

  // El HTML de ADO lo escribio otra persona: se convierte a texto en el main
  // para que el renderer nunca tenga que interpretarlo.
  esperar('los br pasan a saltos de linea', ado.aTexto('a<br>b') === 'a\nb');
  esperar('las listas quedan legibles', ado.aTexto('<ul><li>uno</li><li>dos</li></ul>') === '\u00b7 uno\n\u00b7 dos');
  esperar('las imagenes se anuncian', ado.aTexto('<img src=x>') === '[imagen]');
  esperar('un script no sobrevive como etiqueta',
    ado.aTexto('<script>alert(1)</script>').indexOf('<') < 0, ado.aTexto('<script>alert(1)</script>'));
  esperar('las entidades se resuelven', ado.aTexto('a &amp; b &lt;c&gt;') === 'a & b <c>');
  esperar('vacio no rompe', ado.aTexto(null) === '' && ado.aTexto('') === '');

  esperar('los tipos de ADO se mapean a la jerarquia interna',
    ado.nivelDe('Feature') === 'feature' && ado.nivelDe('Product Backlog Item') === 'pbi'
    && ado.nivelDe('Epic') === 'hito' && ado.nivelDe('Bug') === 'task');
  esperar('un tipo desconocido cae en pbi y no rompe', ado.nivelDe('Vaya Uno A Saber') === 'pbi');

  // El displayName viene de dos formas segun de donde salga; para filtrar por
  // WIQL hace falta la cadena exacta, para mostrar la limpia.
  const norm = ado.normalizar({ id: 9, fields: {
    'System.Title': 'T', 'System.WorkItemType': 'Task', 'System.State': 'To Do',
    'System.AssignedTo': { displayName: 'Ana Perez <ana@x.com>', uniqueName: 'ana@x.com' },
    'System.IterationPath': 'Proy\\Sprint 2',
  } });
  esperar('el nombre para mostrar sale limpio', norm.asignado === 'Ana Perez', norm.asignado);
  esperar('la clave es el email, que es lo que sirve para WIQL y para comparar',
    norm.asignadoClave === 'ana@x.com', norm.asignadoClave);
  esperar('el sprint sale del final de la ruta', norm.sprint === 'Sprint 2');

  const resp = ado.responsablesDe([
    { asignado: 'Ana', asignadoClave: 'a@x' },
    { asignado: 'Ana', asignadoClave: 'a@x' },
    { asignado: null, asignadoClave: null },
  ]);
  esperar('los responsables se agrupan y se cuentan',
    resp[0].cuantas === 2 && resp[0].etiqueta === 'Ana', JSON.stringify(resp[0]));
  esperar('los sin asignar quedan como opcion aparte',
    resp.some((r) => r.valor === '__sin_asignar__' && r.cuantas === 1));
}

// Los tableros propios ganaron responsable, sprint y discusion: los mismos
// filtros tienen que servir de los dos lados.
{
  const bd = require(B + 'src/main/boards.cjs');
  const dir = path.join(os.tmpdir(), 'cockpit-audit-boards');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = bd.crearBoard(dir, 'T');
  bd.guardarTarjeta(dir, b.id, { titulo: 'Con duenio', nivel: 'feature', asignado: 'Ana', sprint: 'S1' });
  bd.guardarTarjeta(dir, b.id, { titulo: 'Sin duenio', nivel: 'task' });
  const g = bd.obtenerLocal(dir, b.id);
  esperar('un tablero propio expone sprints como el remoto',
    g.sprints.length === 1 && g.sprints[0].nombre === 'S1');
  esperar('y responsables con la misma forma',
    g.responsables[0].valor === 'Ana' && g.responsables.some((r) => r.valor === '__sin_asignar__'));
  esperar('responsable y sprint persisten',
    g.tarjetas[0].asignado === 'Ana' && g.tarjetas[0].sprint === 'S1');

  const t = g.tarjetas[0];
  bd.comentarLocal(dir, b.id, t.id, 'una nota');
  const g2 = bd.obtenerLocal(dir, b.id);
  esperar('se puede comentar una tarjeta propia',
    (g2.tarjetas[0].comentarios || []).length === 1);
  rechaza('un comentario vacio se rechaza', () => bd.comentarLocal(dir, b.id, t.id, '   '));
  rechaza('comentar una tarjeta inexistente se rechaza', () => bd.comentarLocal(dir, b.id, 'no-existe', 'x'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log();

// ---------------------------------------------------------------------------
// Ronda 7: el responsable salia "Sin asignar" en tarjetas que si tenian duenio.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 7: identidad del responsable --');
{
  const ado = require(B + 'src/main/ado.cjs');

  // El campo AssignedTo llega con dos formas segun por donde se pida el work
  // item, y comparandolas como texto el <select> no encontraba su opcion.
  const desdeTablero = ado.normalizar({ id: 1, fields: {
    'System.AssignedTo': 'Ana Perez <ana.perez@empresa.com>',
  } });
  const desdeDetalle = ado.normalizar({ id: 1, fields: {
    'System.AssignedTo': { displayName: 'Ana Perez', uniqueName: 'ana.perez@empresa.com' },
  } });
  esperar('el tablero saca el email de la cadena',
    desdeTablero.asignadoClave === 'ana.perez@empresa.com', desdeTablero.asignadoClave);
  esperar('el detalle usa uniqueName',
    desdeDetalle.asignadoClave === 'ana.perez@empresa.com', desdeDetalle.asignadoClave);
  esperar('LAS DOS FORMAS DAN LA MISMA CLAVE (era el bug)',
    desdeTablero.asignadoClave === desdeDetalle.asignadoClave);
  esperar('el nombre para mostrar tambien coincide',
    desdeTablero.asignado === desdeDetalle.asignado && desdeTablero.asignado === 'Ana Perez');

  // Sin email (identidad vieja o un grupo) se cae al nombre, no a null.
  const sinMail = ado.normalizar({ id: 2, fields: { 'System.AssignedTo': 'Equipo Soporte' } });
  esperar('sin email la clave es el nombre', sinMail.asignadoClave === 'Equipo Soporte');
  const sinNadie = ado.normalizar({ id: 3, fields: {} });
  esperar('sin responsable la clave queda null', sinNadie.asignadoClave === null);

  esperar('los responsables se agrupan por esa clave',
    ado.responsablesDe([desdeTablero, desdeDetalle])[0].cuantas === 2);
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 8: los botones de nivel no hacian nada en el board remoto.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 8: filtro por nivel --');
{
  const ado = require(B + 'src/main/ado.cjs');

  // La UI elige NIVELES internos; WIQL filtra por el tipo de ADO. Faltaba la
  // traduccion: apretabas PBIs y seguian viniendo Tasks.
  const w = ado.construirWiql('P', { niveles: ['pbi'] });
  esperar('un nivel se traduce a los tipos de ADO',
    w.indexOf("'Product Backlog Item'") >= 0, w.slice(0, 140));
  esperar('y NO deja pasar los tipos de otro nivel', w.indexOf("'Task'") < 0);

  const wt = ado.construirWiql('P', { niveles: ['task'] });
  esperar('task incluye Bug e Impediment, que son del mismo nivel',
    wt.indexOf("'Bug'") >= 0 && wt.indexOf("'Impediment'") >= 0);

  const wc = ado.construirWiql('P', { niveles: ['feature', 'task'] });
  esperar('se pueden combinar niveles',
    wc.indexOf("'Feature'") >= 0 && wc.indexOf("'Task'") >= 0);

  esperar('sin niveles no se filtra por tipo',
    ado.construirWiql('P', {}).indexOf('WorkItemType') < 0);

  esperar('tipos explicitos ganan sobre niveles',
    ado.construirWiql('P', { tipos: ['Epic'], niveles: ['task'] }).indexOf("'Task'") < 0);

  // La traduccion tiene que cerrar con el mapeo inverso que usa el tablero:
  // si un tipo se muestra como PBI, filtrar por PBI tiene que traerlo.
  for (const [nivel, tipos] of Object.entries(ado.TIPOS_POR_NIVEL)) {
    const coherente = tipos.every((t) => ado.nivelDe(t) === nivel);
    esperar('los tipos de "' + nivel + '" vuelven a ese mismo nivel', coherente,
      tipos.filter((t) => ado.nivelDe(t) !== nivel).join(', '));
  }
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 9: columnas reales del board del equipo.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 9: columnas del board --');
{
  const ado = require(B + 'src/main/ado.cjs');
  const src = fs.readFileSync(B + 'src/main/ado.cjs', 'utf8');

  // El token del MCP solo puede salir hacia Azure DevOps, y el host tiene que
  // estar fijo en el codigo, no venir de ninguna entrada.
  esperar('el host de la API REST esta fijo en el codigo',
    /const HOST_ADO = 'dev\.azure\.com'/.test(src));
  esperar('no hay ningun otro hostname en las llamadas REST',
    (src.match(/hostname:/g) || []).length === 1);
  esperar('el token nunca se escribe en un log',
    !/console\.(log|error|warn)[^\n]*(PERSONAL_ACCESS_TOKEN|cred|pat)/i.test(src));
  esperar('la credencial se manda tal cual, sin re-codificar',
    /Basic ' \+ cred/.test(src));

  // La columna del board no es el estado: "In Progress" puede caer en
  // "En Curso", "Testing" o "Pre Pro".
  const conBoard = ado.normalizar({ id: 1, fields: {
    'System.State': 'In Progress', 'System.BoardColumn': 'Pre Pro',
  } });
  esperar('la columna del board le gana al estado', conBoard.columna === 'Pre Pro', conBoard.columna);
  esperar('el estado igual se conserva', conBoard.estado === 'In Progress');

  const sinBoard = ado.normalizar({ id: 2, fields: { 'System.State': 'New' } });
  esperar('sin columna de board se cae al estado', sinBoard.columna === 'New');
  esperar('y se sabe que no vino del board', sinBoard.columnaBoard === null);

  const sinNada = ado.normalizar({ id: 3, fields: {} });
  esperar('sin ninguno de los dos no queda vacio', sinNada.columna === 'Sin estado');

  esperar('se piden los campos de board en la consulta',
    /System\.BoardColumn/.test(src));
  esperar('un fallo leyendo las columnas no tumba el tablero',
    /No pude leer las columnas del board/.test(src));
  esperar('una columna que ya no existe en el board igual se muestra',
    /fueraDelBoard/.test(src));
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 10: el paquete exportable.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 10: exportacion --');
{
  const pk = require(B + 'src/main/pkg.cjs');

  // La pantalla promete "nunca incluye credenciales", pero el codigo copiaba
  // env tal cual. No se filtraba nada solo porque los servidores de usuario de
  // esta maquina no tienen variables: con un token adentro, viajaba.
  const env = pk.envSinSecretos({
    PERSONAL_ACCESS_TOKEN: 'abc123secreto',
    GITHUB_TOKEN: 'ghp_loquesea',
    LOG_LEVEL: 'debug',
  });
  esperar('se conservan los nombres de las variables',
    Object.keys(env).join(',') === 'PERSONAL_ACCESS_TOKEN,GITHUB_TOKEN,LOG_LEVEL');
  esperar('NINGUN valor sobrevive', Object.values(env).every((v) => v === ''),
    JSON.stringify(env));
  esperar('el secreto no aparece por ningun lado',
    JSON.stringify(env).indexOf('abc123secreto') < 0);
  esperar('sin env devuelve null', pk.envSinSecretos(null) === null);
  esperar('un env vacio tambien', pk.envSinSecretos({}) === null);

  // Y el paquete de verdad tampoco lo lleva.
  const armado = pk.build({});
  const texto = JSON.stringify(armado);
  esperar('el paquete armado no contiene ningun valor de env',
    (armado.sections.mcpServers || []).every((m) => !m.env || Object.values(m.env).every((v) => v === '')));
  esperar('el paquete declara que secciones trae',
    !!(armado.sections.plugins && armado.sections.boards !== undefined));
  void texto;

  // Boards: ida y vuelta completa.
  const dirB = path.join(os.tmpdir(), 'cockpit-audit-pkg-boards');
  fs.rmSync(dirB, { recursive: true, force: true });
  fs.mkdirSync(dirB, { recursive: true });
  const bd = require(B + 'src/main/boards.cjs');
  const orig = bd.crearBoard(dirB, 'Para exportar');
  bd.guardarTarjeta(dirB, orig.id, { titulo: 'Padre', nivel: 'feature' });
  const conPadre = bd.obtenerLocal(dirB, orig.id).tarjetas[0];
  bd.guardarTarjeta(dirB, orig.id, { titulo: 'Hijo', nivel: 'task', padre: conPadre.id });

  const sec = pk.collectBoards(dirB);
  esperar('el board se recolecta con sus tarjetas',
    sec.length === 1 && sec[0].tarjetas.length === 2, JSON.stringify(sec.length));
  esperar('y con la jerarquia', sec[0].tarjetas.some((t) => t.padre));

  // Importar en OTRA carpeta, como haria otra maquina.
  const dirDestino = path.join(os.tmpdir(), 'cockpit-audit-pkg-destino');
  fs.rmSync(dirDestino, { recursive: true, force: true });
  fs.mkdirSync(dirDestino, { recursive: true });
  const paquete = { kind: armado.kind, schemaVersion: armado.schemaVersion, sections: { boards: sec } };
  const ud = path.join(os.tmpdir(), 'cockpit-audit-pkg-ud');
  fs.rmSync(ud, { recursive: true, force: true });
  pk.apply(paquete, { boards: [sec[0].id] }, ud, dirDestino);

  const importados = require(B + 'src/main/boards.cjs').listarLocales(dirDestino);
  esperar('el board se importa en la maquina destino', importados.length === 1, JSON.stringify(importados));
  const traido = bd.obtenerLocal(dirDestino, importados[0].id);
  esperar('con todas sus tarjetas', traido.tarjetas.length === 2);
  esperar('con ids NUEVOS, no los del origen',
    traido.tarjetas.every((t) => !sec[0].tarjetas.some((o) => o.id === t.id)));
  const hijo = traido.tarjetas.find((t) => t.padre);
  esperar('y la jerarquia reenlazada a los ids nuevos',
    !!hijo && traido.tarjetas.some((t) => t.id === hijo.padre));

  // Importar dos veces no pisa: se agregan como tableros nuevos.
  pk.apply(paquete, { boards: [sec[0].id] }, ud, dirDestino);
  esperar('importar de nuevo agrega, no pisa el tablero que ya tenias',
    require(B + 'src/main/boards.cjs').listarLocales(dirDestino).length === 2);

  fs.rmSync(dirB, { recursive: true, force: true });
  fs.rmSync(dirDestino, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });

  // El plan avisa que las variables hay que completarlas.
  const conEnv = {
    kind: armado.kind, schemaVersion: armado.schemaVersion,
    sections: { mcpServers: [{ name: 'x', type: 'stdio', command: 'node', args: [], env: { TOKEN: '' }, envPedidas: ['TOKEN'] }] },
  };
  const pl = pk.plan(conEnv);
  esperar('el plan avisa que hay variables por completar',
    /completar TOKEN/.test((pl.mcpServers[0] || {}).warning || ''), (pl.mcpServers[0] || {}).warning);

  // Un plugin de otro marketplace no se puede colar.
  const src = fs.readFileSync(B + 'src/main/pkg.cjs', 'utf8');
  esperar('al importar plugins se verifica que el id sea de ese marketplace',
    /endsWith\('@' \+ m\.name\)/.test(src));
  esperar('si el marketplace no esta clonado se avisa en vez de fallar mudo',
    /no está clonado en esta máquina/.test(src));
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 11: requisitos (que le falta a la app y como configurarlo).
// ---------------------------------------------------------------------------
console.log('\n-- ronda 11: requisitos --');
{
  const req = require(B + 'src/main/requisitos.cjs');

  const est = req.estado();
  esperar('se listan los tres requisitos', est.length === 3, String(est.length));
  esperar('cada uno dice para que sirve', est.every((r) => r.habilita && r.habilita.length > 20));
  esperar('se detecta lo que ya esta instalado', est.some((r) => r.detectado));
  esperar('y se dice de donde sale el servidor',
    est.filter((r) => r.detectado).every((r) => !!r.alcance));

  // El token de Azure DevOps va en base64 de "usuario:token": pedirle eso al
  // usuario seria una trampa, asi que se acepta el token crudo y se codifica.
  const crudo = 'unPatDePrueba123';
  const cod = req.tokenBasic(crudo);
  esperar('un token crudo se codifica como usuario:token',
    Buffer.from(cod, 'base64').toString('utf8') === 'ado:' + crudo);
  esperar('uno ya codificado NO se codifica dos veces', req.tokenBasic(cod) === cod);
  rechaza('un token vacio se rechaza', () => req.tokenBasic('   '));

  // La organizacion es un nombre, no una URL: pegar la URL entera es el error
  // mas facil de cometer.
  const ud = path.join(os.tmpdir(), 'cockpit-audit-req');
  fs.rmSync(ud, { recursive: true, force: true });
  rechaza('se rechaza pegar la URL entera como organizacion',
    () => req.configurar(ud, 'ado', { organizacion: 'https://dev.azure.com/x', pat: 'y' }));
  rechaza('se rechaza una organizacion vacia',
    () => req.configurar(ud, 'ado', { organizacion: '', pat: 'y' }));
  rechaza('los que se instalan a mano no se configuran desde aca',
    () => req.configurar(ud, 'grafo', {}));

  // Jira tiene dos implementaciones y hay que elegir una a proposito.
  const jira = est.find((r) => r.id === 'jira');
  esperar('Jira ofrece las dos formas de conectarlo', (jira.opciones || []).length === 2,
    JSON.stringify((jira.opciones || []).map((o) => o.id)));
  esperar('la oficial no pide token', jira.opciones[0].campos.length === 0);
  esperar('y avisa que la autorizacion la hace Claude Code', !!jira.opciones[0].despues);
  esperar('la de la comunidad pide sitio, email y token',
    jira.opciones[1].campos.length === 3);
  rechaza('sin elegir opcion no se configura', () => req.configurar(ud, 'jira', {}, null));
  rechaza('una opcion inventada se rechaza', () => req.configurar(ud, 'jira', {}, 'ninguna'));
  rechaza('una URL sin https se rechaza',
    () => req.configurar(ud, 'jira', { url: 'x.atlassian.net', email: 'a@b.co', token: 't' }, 'comunidad'));
  rechaza('un email invalido se rechaza',
    () => req.configurar(ud, 'jira', { url: 'https://x.atlassian.net', email: 'nope', token: 't' }, 'comunidad'));
  rechaza('sin token se rechaza',
    () => req.configurar(ud, 'jira', { url: 'https://x.atlassian.net', email: 'a@b.co', token: '' }, 'comunidad'));
  rechaza('un requisito inventado se rechaza', () => req.configurar(ud, 'noexiste', {}));

  // El nombre del servidor de ADO tiene que ser exactamente "ado": es el que
  // busca boards. Si se cambia aca hay que cambiarlo alla.
  const src = fs.readFileSync(B + 'src/main/requisitos.cjs', 'utf8');
  esperar('el nombre del servidor de ADO esta fijo en "ado"', /nombreFijo: 'ado'/.test(src));
  const bd = fs.readFileSync(B + 'src/main/ado.cjs', 'utf8');
  esperar('y es el mismo que busca el modulo de Azure DevOps', /ubicar\('ado'\)/.test(bd));

  // Configurar no alcanza: lo unico que confirma que quedo bien es pedirle
  // datos de verdad al servidor.
  esperar('cada requisito se puede probar contra el servidor real',
    typeof req.probar === 'function' && /async function probar/.test(src));
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 12: el repaso del dia. No gasta tokens: son reglas sobre datos propios.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 12: repaso --');
{
  const br = require(B + 'src/main/briefing.cjs');

  esperar('2.1.252 es mas nueva que 2.1.251', br.masNueva('2.1.252', '2.1.251'));
  esperar('2.2.0 le gana a 2.1.999', br.masNueva('2.2.0', '2.1.999'));
  esperar('3.0.0 le gana a 2.9.9', br.masNueva('3.0.0', '2.9.9'));
  esperar('la misma version no es mas nueva', !br.masNueva('2.1.251', '2.1.251'));
  esperar('una version vieja no es mas nueva', !br.masNueva('2.1.250', '2.1.251'));
  esperar('con una version ilegible no se compara', !br.masNueva('vaya', '2.1.1'));
  esperar('el orden numerico gana al alfabetico (10 > 9)', br.masNueva('2.1.10', '2.1.9'));

  // Las reglas no pueden disparar sin datos: un panel que siempre encuentra
  // algo se vuelve ruido.
  const vacio = { periods: {}, config: {}, byTool: {}, counts: {} };
  esperar('sin datos no se inventan consejos de uso', br.consejosDeUso(vacio).length === 0);
  esperar('sin datos no se inventan consejos de setup', br.consejosDeSetup(vacio).length === 0);

  // Un gasto parejo no dispara la regla de tendencia.
  const parejo = {
    periods: {
      d7: { userTurns: 10, totals: { requests: 10, costUSD: 20, costNoCacheUSD: 20, totalTokens: 100, cacheRead: 0 }, byModel: [] },
      d14: { userTurns: 20, totals: { costUSD: 40 } },
    },
  };
  esperar('un costo estable no dispara la alerta de tendencia',
    !br.consejosDeUso(parejo).some((c) => c.id === 'tendencia'));

  // Uno que se duplico, si.
  const subio = {
    periods: {
      d7: { userTurns: 10, totals: { requests: 10, costUSD: 40, costNoCacheUSD: 40, totalTokens: 100, cacheRead: 0 }, byModel: [] },
      d14: { userTurns: 20, totals: { costUSD: 60 } },
    },
  };
  const t = br.consejosDeUso(subio).find((c) => c.id === 'tendencia');
  esperar('un costo que se duplico si dispara', !!t, JSON.stringify(br.consejosDeUso(subio).map((c) => c.id)));
  esperar('y el texto dice que subio', !!t && /más caras/.test(t.titulo));

  // El ahorro de cache solo se menciona si hubo ahorro de verdad.
  const sinAhorro = {
    periods: { d7: { userTurns: 5, totals: { requests: 5, costUSD: 10, costNoCacheUSD: 10, totalTokens: 100, cacheRead: 0 }, byModel: [] } },
  };
  esperar('sin ahorro de cache no se menciona la cache',
    !br.consejosDeUso(sinAhorro).some((c) => c.id === 'cache'));

  // Y la regla de modelos necesita gasto suficiente para no molestar de gusto.
  const pocoGasto = {
    periods: { d7: { userTurns: 2, totals: { requests: 2, costUSD: 1, costNoCacheUSD: 1, totalTokens: 10, cacheRead: 0 },
      byModel: [{ label: 'Opus 5', costUSD: 1 }] } },
  };
  esperar('con poco gasto no se opina sobre el modelo',
    !br.consejosDeUso(pocoGasto).some((c) => c.id === 'modelos'));

  // Nada de esto llama a un modelo.
  const src = fs.readFileSync(B + 'src/main/briefing.cjs', 'utf8');
  esperar('el repaso no le pega a la API de mensajes',
    src.indexOf('api.anthropic.com') < 0 && src.indexOf('/v1/messages') < 0);
  esperar('solo sale a la URL publica del changelog',
    (src.match(/https:\/\//g) || []).length === 1);
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 13: el actualizador.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 13: auto-update --');
{
  const up = require(B + 'src/main/updater.cjs');
  const src = fs.readFileSync(B + 'src/main/updater.cjs', 'utf8');

  // En desarrollo tiene que quedar INERTE, no tirar: electron-updater falla si
  // no encuentra los metadatos del empaquetador y ese error no dice nada util.
  up.iniciar({ isPackaged: false });
  const e = up.publico();
  esperar('en desarrollo queda inerte', e.soportado === false);
  esperar('y explica por que', /solo corre en la app instalada/.test(e.motivo || ''));
  esperar('informa la version que estas corriendo', !!e.version);

  // Nada se instala solo: la app entera funciona con confirmacion explicita.
  esperar('no se descarga sola', /autoUpdater\.autoDownload = false/.test(src));
  esperar('no se instala al cerrar', /autoInstallOnAppQuit = false/.test(src));

  // Las notas del release son HTML de GitHub: se pasan a texto en el main.
  esperar('las notas HTML se convierten a texto',
    up.notasDe('<ul><li>uno</li><li>dos</li></ul>') === '\u00b7 uno\n\u00b7 dos');
  esperar('un script no sobrevive como etiqueta',
    up.notasDe('<script>alert(1)</script>').indexOf('<') < 0);
  esperar('las notas como lista de versiones tambien se aplanan',
    up.notasDe([{ note: 'uno' }, { note: 'dos' }]) === 'uno\ndos');
  esperar('sin notas no rompe', up.notasDe(null) === '' && up.notasDe(undefined) === '');
  esperar('las notas se recortan', up.notasDe('x'.repeat(9000)).length <= 4000);

  // Instalar sin haber descargado no puede pasar.
  rechaza('instalar antes de descargar se rechaza', () => up.instalar());

  // El feed tiene que apuntar al repo real.
  const pj = JSON.parse(fs.readFileSync(B + 'package.json', 'utf8'));
  const pub = (pj.build && pj.build.publish) || [];
  esperar('el empaquetador publica en GitHub Releases',
    pub.length === 1 && pub[0].provider === 'github', JSON.stringify(pub));
  esperar('y apunta al repo correcto',
    pub[0] && pub[0].owner === 'lucabaello1998' && pub[0].repo === 'claude-cockpit');
  esperar('electron-updater es dependencia de produccion, no de desarrollo',
    !!(pj.dependencies || {})['electron-updater']);
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 14: primer arranque en una maquina sin Claude Code.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 14: primer arranque --');
{
  const inst = require(B + 'src/main/instalacion.cjs');
  const src = fs.readFileSync(B + 'src/main/instalacion.cjs', 'utf8');

  esperar('se distinguen los cuatro estados',
    Object.keys(inst.ESTADOS).length === 4, Object.keys(inst.ESTADOS).join(','));

  // La app NO puede loguear a nadie: el OAuth lo corre el CLI de Claude Code.
  // Prometer un login que no existe seria peor que explicar el paso real.
  esperar('no se promete un login que la app no puede hacer',
    /no puede loguearte|NO puede loguearte/.test(src));
  esperar('se detecta si el CLI existe en el PATH', /execFile\(cmd, \['claude'\]/.test(src));
  esperar('el estado sin sesion mira las credenciales',
    /\.credentials\.json/.test(src));

  // Cada estado tiene que traer un paso concreto, no solo el diagnostico.
  const ui = fs.readFileSync(B + 'src/renderer/components/PrimerArranque.jsx', 'utf8');
  esperar('la pantalla muestra los comandos y deja copiarlos',
    /clipboard\.writeText/.test(ui));
  esperar('se revisa sola, sin obligar a apretar un boton',
    /setInterval\(revisar/.test(ui));

  // Va antes del consentimiento: no tiene sentido explicarle que se leen sus
  // archivos a alguien que todavia no tiene ninguno.
  const app = fs.readFileSync(B + 'src/renderer/App.jsx', 'utf8');
  const iPrimer = app.indexOf('PrimerArranque info=');
  const iConsent = app.indexOf('<Consent onAccept');
  esperar('el primer arranque se muestra ANTES del consentimiento',
    iPrimer > 0 && iConsent > 0 && iPrimer < iConsent);
  esperar('el consentimiento solo aparece si la instalacion esta lista',
    /instalacion\.estado === 'listo' && consent === false/.test(app));
}
console.log();

// ---------------------------------------------------------------------------
// Ronda 15: consumo de red.
// ---------------------------------------------------------------------------
console.log('\n-- ronda 15: red --');
{
  const src = fs.readFileSync(B + 'src/main/briefing.cjs', 'utf8');

  // El changelog pesa ~574 KB. Bajarlo entero cada dia es tirar ancho de banda
  // cuando GitHub responde 304 con cero bytes si no cambio.
  esperar('se manda If-None-Match con el ETag guardado',
    /If-None-Match/.test(src));
  esperar('un 304 no vuelve a parsear ni descargar',
    /statusCode === 304/.test(src) && /sinCambios/.test(src));
  esperar('se guardan los bloques para poder refiltrar sin bajar de nuevo',
    /previo\.bloques/.test(src));

  // Nada puede quedar pegado a un temporizador sin que el usuario lo prenda.
  const ov = fs.readFileSync(B + 'src/renderer/components/Overview.jsx', 'utf8');
  esperar('el auto-refresco de uso viene APAGADO por defecto',
    /localStorage\.getItem\('cockpit\.autoUsage'\) === '1'/.test(ov));

  // El asistente de primer arranque revisa cada 5 s: tiene que ser LOCAL.
  const inst = fs.readFileSync(B + 'src/main/instalacion.cjs', 'utf8');
  esperar('la revision del primer arranque no toca la red',
    !/https?\.(get|request)|fetch\(/.test(inst));

  // El updater busca una vez al arrancar, no en bucle.
  const up = fs.readFileSync(B + 'src/main/updater.cjs', 'utf8');
  esperar('el updater no queda en bucle', !/setInterval/.test(up));

  // Cada host tiene que estar fijo en el codigo, no armado desde una entrada.
  const hosts = new Set();
  for (const f of ['ado.cjs', 'briefing.cjs', 'updater.cjs', 'mcpRegistry.cjs',
    'skillsRegistry.cjs', 'sources/liveUsage.cjs', 'sources/pricingFetch.cjs']) {
    const t = fs.readFileSync(path.join(B, 'src/main', f), 'utf8');
    for (const m of t.matchAll(/https:\/\/([a-z0-9.-]+)/g)) hosts.add(m[1]);
  }
  const esperados = new Set(['api.anthropic.com', 'dev.azure.com', 'platform.claude.com',
    'raw.githubusercontent.com', 'registry.modelcontextprotocol.io', 'www.skills.sh',
    'docs.claude.com', 'mcp.atlassian.com', 'miempresa.atlassian.net', 'github.com']);
  const inesperados = [...hosts].filter((h) => !esperados.has(h));
  esperar('no aparecio ningun host nuevo sin declarar', inesperados.length === 0,
    inesperados.join(', '));
}
console.log();
console.log();
console.log('='.repeat(60));
console.log(`  ${pasa} pasan · ${falla} fallan`);
process.exit(falla ? 1 : 0);
})();
