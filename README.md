<p align="center">
  <img src="docs/banner.svg" alt="Claude Cockpit" width="100%">
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-2b2b28?style=flat-square&labelColor=1a1a18">
  <img alt="React" src="https://img.shields.io/badge/React-19-2b2b28?style=flat-square&labelColor=1a1a18">
  <img alt="Tests" src="https://img.shields.io/badge/tests-280%20passing-3d7a3d?style=flat-square&labelColor=1a1a18">
  <img alt="Sin telemetría" src="https://img.shields.io/badge/telemetr%C3%ADa-ninguna-d97757?style=flat-square&labelColor=1a1a18">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-instalador-2b2b28?style=flat-square&labelColor=1a1a18">
</p>

<p align="center">
  <b>Español</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/lucabaello1998/claude-cockpit/releases/latest"><b>⬇ Descargar el instalador</b></a>
</p>

---

Claude Code te deja un montón de información en el disco: cada conversación, el
`usage` de cada request, lo que gastaron los subagentes, las memorias, los MCP,
los hooks. Pero no tenés forma de mirarla.

**Claude Cockpit lee todo eso y te lo muestra.** Corre en tu máquina, no tiene
servidor, no manda telemetría, y no escribe nada en tu configuración sin que lo
confirmes.

## Instalar

Bajá el instalador desde
[Releases](https://github.com/lucabaello1998/claude-cockpit/releases/latest) y
ejecutalo. No hace falta Node ni correr nada.

> Windows te va a mostrar un aviso de SmartScreen: el instalador no está firmado
> (el certificado es pago). *Más información → Ejecutar de todas formas*, o
> compilalo vos con los pasos de abajo.

### Desde el código

```bash
npm install
npm start          # build + abrir la app
```

| Comando | Qué hace |
|---|---|
| `npm run dev` | Vite + Electron con hot reload |
| `npm start` | build y abre la app |
| `npm run dist` | instalador NSIS en `release/` |
| `npm run audit` | la suite de seguridad y correctitud |
| `npm run icon` | regenera `build/icon.ico` |

Necesita **Node 20+**. Está probado en Windows; el código no tiene nada
específico de plataforma salvo el empaquetado, que hoy solo genera un
instalador de Windows.

> Si lo corrés desde una terminal de Claude Code, usá `npm start` y no el `.exe`
> directo: esa terminal define `ELECTRON_RUN_AS_NODE=1` y Electron arranca como
> Node pelado. `scripts/launch.cjs` limpia esa variable.

## La primera vez

Si Claude Code no está instalado en la máquina, o está pero sin sesión iniciada,
la app te lo dice y te guía en vez de abrir con todos los paneles vacíos. Revisa
sola cada pocos segundos, así que podés dejar la ventana abierta mientras
ejecutás el comando.

Para ser claro con lo que **no** puede hacer: **Claude Cockpit no puede
iniciarte sesión.** El login de Claude Code es un OAuth que corre el CLI y
guarda el token en tu carpeta. Esta app solo lo lee, y solo cuando le pedís
actualizar el uso.

## Qué muestra

| Panel | Para qué |
|---|---|
| **Resumen** | Medidores 5 h / 7 días, gasto por período, por proyecto y por modelo |
| **Repaso** | Una vez por día: qué tenés sin cerrar, cómo viene tu gasto contra la semana pasada, y qué salió en Claude Code desde tu versión |
| **Tokens y costo** | Series por día u hora, desglose por modelo, cuánto te ahorró la caché |
| **Conversaciones** | Los transcripts completos, con los subagentes aparte |
| **Memorias** | Lo que Claude guardó, más los grafos de código si tenés alguno indexado |
| **Boards** | Work items de Azure DevOps con filtros por nivel, sprint y responsable, más tableros Kanban propios con jerarquía Hito → Feature → PBI → Task |
| **Configuración** | MCP, skills, workflows, hooks, plugins y proyectos editables, y un paquete exportable para llevarte el setup a otra máquina |

Nada de esto necesita configurar un MCP: **sin ninguno, todo lo que sale de leer
archivos funciona igual.** Los que faltan se listan en *Configuración →
Requisitos*, que explica qué habilita cada uno, lo configura y lo prueba contra
el servidor real.

## Por qué los números dan bien

Esta es la parte difícil, y la razón de que el proyecto exista. Hacer un
dashboard es fácil; hacer uno que no mienta, no tanto. Cuatro cosas que hay que
acertar y que no son obvias:

**El transcript reescribe la misma fila mientras streamea.** El mismo
`requestId` aparece varias veces con el `usage` acumulado. Si contás todas las
filas, el gasto sale unas **4× inflado**. Hay que deduplicar por `requestId` y
quedarse con la última.

**Los subagentes viven en archivos aparte.** Están en
`projects/<proj>/<sessionId>/subagents/**/*.jsonl`, no en el transcript
principal. En una medición real eran **$154 de $604** que simplemente no
aparecían.

**Los días son locales, no UTC.** Agrupando por UTC, todo lo que trabajás
después de las 21:00 en Argentina cae en el día siguiente.

**La caché tiene su propia economía.** Leer de caché sale 0,1× del input;
escribirla sale 1,25× (5 min) o 2× (1 hora). Sin eso, ni el costo ni el ahorro
dan.

## Cómo está armado

<p align="center">
  <img src="docs/arquitectura.svg" alt="Arquitectura" width="100%">
</p>

El índice es **incremental**: un `.jsonl` solo crece por el final, así que se
retoma desde el último byte leído en vez de releerlo entero. Con un transcript
de 56 MB, eso es la diferencia entre **231 ms y 10 ms** cada vez que la sesión
escribe una línea.

Los costos se recalculan al construir el snapshot, no al indexar: cambiar la
tabla de precios se ve al instante sin reindexar nada.

## Seguridad

La app lee archivos personales y puede escribir configuración de Claude Code, así
que el modelo de seguridad no es un detalle:

- **Contención de rutas.** Todo lo que viene del renderer o de un paquete
  importado pasa por `safePaths` antes de tocar el disco. Se compara con
  `path.relative`, no con `startsWith`: `skills-malicioso` empieza con `skills`.
- **Se sigue el symlink.** `resolve()` no lo hace, así que un enlace dentro de
  `hooks/` podía desviar la escritura afuera de `~/.claude`.
- **Los MCP se lanzan sin reinterpretación de shell.** En Windows el comando va
  validado y sin comillas, y cada argumento entrecomillado: un `&&` viaja como
  texto, no como operador.
- **El HTML ajeno se convierte a texto en el proceso principal.** Las
  descripciones de Azure DevOps y las notas de un release las escribió otra
  persona; el renderer nunca las interpreta.
- **Al importar un paquete** siempre hay backup previo, vista previa y
  confirmación por cada cosa. Nunca marca un proyecto como confiado: esa
  decisión la seguís tomando vos en Claude Code.

```bash
npm run audit
```

280 pruebas. No son tests de humo: **intentan explotar cada superficie de
escritura** (traversal, symlinks, inyección de comandos, contaminación de
prototipo, índices negativos) y verifican que quede contenido. La suite creció
a partir de agujeros reales que se encontraron y se corrigieron.

## Qué sale a internet

Nada por su cuenta. Solo estos cuatro destinos, y siempre porque lo pediste:

| Destino | Cuándo |
|---|---|
| `api.anthropic.com/api/oauth/usage` | Solo al apretar **Actualizar uso**. El token se lee en ese momento, no se guarda ni se copia |
| `dev.azure.com` | Solo si configuraste Boards, con tu propio PAT |
| `raw.githubusercontent.com` | El changelog público de Claude Code, para el Repaso |
| `platform.claude.com` | La tabla de precios, solo al apretar **Buscar precios actualizados** |

## Sobre los dólares

Los **tokens son exactos**: salen del transcript. Los precios en dólares son una
**estimación a tarifa API pública**. Si tu cuenta es por suscripción no se
factura por token, así que sirven para comparar sesiones entre sí, no como
factura. Se pueden apagar y ver solo tokens.

## Publicar una versión

La app se actualiza sola contra los releases de GitHub:

1. Subir `version` en `package.json`.
2. `npm run dist` — genera en `release/` el instalador, su `.blockmap` y
   **`latest.yml`**, que es el archivo de metadatos que lee el actualizador.
3. Crear el release con el tag `v<version>` y **subir los tres archivos**. Si
   falta `latest.yml`, la app no se entera de que hay algo nuevo.

Con `GH_TOKEN` en el entorno, `npx electron-builder --publish always` hace el
paso 3 solo.

El actualizador **no instala nada sin que lo pidas**: avisa, muestra las notas
del release, y vos elegís cuándo descargar y cuándo reiniciar. El instalador no
está firmado, así que Windows muestra el aviso de SmartScreen igual que en la
instalación inicial.

## Licencia

Todos los derechos reservados. El código está a la vista para que puedas leerlo,
pero no se otorga licencia de uso, copia, modificación ni distribución.

---

<p align="center">
  <sub>Hecho para entender en qué se me iba el tiempo y la plata con Claude Code.</sub>
</p>
