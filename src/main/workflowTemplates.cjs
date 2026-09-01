'use strict';

// Ejemplos ejecutables de workflows. No son rellenos: cada uno resuelve un caso
// que se pide seguido, y estan escritos con la API real (la misma que usa
// quick-task.js, el unico que ya tenias).

const REVISAR = `export const meta = {
  name: 'revisar-cambios',
  description: 'Revisa el diff actual por varias dimensiones a la vez y verifica cada hallazgo.',
  phases: [{ title: 'Revisar' }, { title: 'Verificar' }],
}

// Cada dimension mira una cosa distinta. Separarlas evita que un solo agente
// diluya la atencion entre bugs, performance y estilo.
const DIMENSIONES = [
  { key: 'bugs', prompt: 'Busca errores de correctitud en el diff: casos borde, nulos, off-by-one, condiciones invertidas.' },
  { key: 'seguridad', prompt: 'Busca problemas de seguridad en el diff: inyeccion, rutas sin validar, secretos, permisos.' },
  { key: 'perf', prompt: 'Busca problemas de rendimiento en el diff: trabajo en bucles, consultas repetidas, memoria que crece.' },
]

const HALLAZGOS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['file', 'title', 'why'],
      },
    },
  },
  required: ['findings'],
}

const VEREDICTO = {
  type: 'object',
  properties: {
    esReal: { type: 'boolean' },
    razon: { type: 'string' },
  },
  required: ['esReal', 'razon'],
}

phase('Revisar')

// pipeline: cada dimension pasa a verificarse en cuanto termina, sin esperar a
// las demas. Con parallel habria que esperar a que las tres cierren.
const porDimension = await pipeline(
  DIMENSIONES,
  (d) => agent(
    d.prompt + ' Mira el diff con git diff. Reporta solo lo que puedas justificar.',
    { label: 'revisar:' + d.key, phase: 'Revisar', schema: HALLAZGOS, effort: 'high' }
  ),
  (revision) => parallel(
    (revision.findings || []).map((f) => () =>
      agent(
        'Verifica de forma adversarial este hallazgo. Si no podes construir un caso concreto que falle, decl' +
        'aralo falso.\\n' + JSON.stringify(f),
        { label: 'verificar:' + f.file, phase: 'Verificar', schema: VEREDICTO }
      ).then((v) => ({ ...f, veredicto: v }))
    )
  )
)

const confirmados = porDimension.flat().filter(Boolean).filter((f) => f.veredicto && f.veredicto.esReal)

return { confirmados, total: porDimension.flat().length }
`;

const INVESTIGAR = `export const meta = {
  name: 'investigar',
  description: 'Reparte una investigacion entre varios agentes y junta las respuestas en una sola.',
  phases: [{ title: 'Buscar' }, { title: 'Sintetizar' }],
}

const pregunta = (args && args.pregunta) || ''
if (!pregunta) throw new Error('Falta args.pregunta')

const angulos = (args && args.angulos) || [
  'Que dice la documentacion oficial',
  'Que problemas reportan quienes ya lo usaron',
  'Que alternativas existen y cuando conviene cada una',
]

const RESUMEN = {
  type: 'object',
  properties: {
    hallazgos: { type: 'array', items: { type: 'string' } },
    fuentes: { type: 'array', items: { type: 'string' } },
  },
  required: ['hallazgos'],
}

phase('Buscar')

// Aca si conviene parallel: la sintesis necesita TODAS las respuestas.
const partes = await parallel(
  angulos.map((a) => () =>
    agent(
      'Pregunta: ' + pregunta + '\\nTu angulo: ' + a +
      '\\nBusca en la web si hace falta. Cita las fuentes. No repitas lo obvio.',
      { label: 'buscar', phase: 'Buscar', schema: RESUMEN, effort: 'medium' }
    )
  )
)

phase('Sintetizar')

const sintesis = await agent(
  'Junta estas investigaciones en una respuesta sola. Marca donde se contradicen entre si.\\n' +
  JSON.stringify(partes.filter(Boolean)),
  { label: 'sintetizar', phase: 'Sintetizar', effort: 'high' }
)

return { sintesis, partes }
`;

const TESTS = `export const meta = {
  name: 'cubrir-con-tests',
  description: 'Encuentra codigo sin cobertura y escribe tests para lo que mas riesgo tiene.',
  phases: [{ title: 'Analizar' }, { title: 'Escribir' }],
}

const objetivo = (args && args.objetivo) || 'src'

const HUECOS = {
  type: 'object',
  properties: {
    huecos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          funcion: { type: 'string' },
          riesgo: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
        },
        required: ['file', 'funcion', 'riesgo'],
      },
    },
  },
  required: ['huecos'],
}

phase('Analizar')

const analisis = await agent(
  'Revisa ' + objetivo + ' y encontra funciones sin tests. Ordena por riesgo real: ' +
  'lo que maneja plata, permisos, rutas o entrada del usuario va primero.',
  { label: 'analizar', phase: 'Analizar', schema: HUECOS, effort: 'high' }
)

const altos = (analisis.huecos || []).filter((h) => h.riesgo === 'alto').slice(0, 5)
if (!altos.length) return { mensaje: 'No encontre huecos de riesgo alto', analisis }

phase('Escribir')

const escritos = await parallel(
  altos.map((h) => () =>
    agent(
      'Escribi tests para ' + h.funcion + ' en ' + h.file + '. Que fallen si la funcion se rompe, ' +
      'no que confirmen lo que ya hace. Cubri los casos borde. Corre la suite y deja todo en verde.',
      { label: 'tests:' + h.funcion, phase: 'Escribir', effort: 'high' }
    )
  )
)

return { altos, escritos: escritos.filter(Boolean) }
`;

const PLANTILLAS = [
  {
    id: 'revisar-cambios',
    file: 'revisar-cambios.js',
    titulo: 'Revisar el diff por dimensiones',
    para: 'Tres agentes miran bugs, seguridad y rendimiento por separado; cada hallazgo pasa por un verificador adversarial.',
    ensena: ['pipeline', 'schema', 'verificacion adversarial'],
    agentes: '3 + 1 por hallazgo',
    codigo: REVISAR,
  },
  {
    id: 'investigar',
    file: 'investigar.js',
    titulo: 'Investigar en paralelo y sintetizar',
    para: 'Reparte una pregunta en varios ángulos, busca en paralelo y junta todo en una respuesta, marcando contradicciones.',
    ensena: ['parallel', 'args', 'fase de sintesis'],
    agentes: '3 + 1',
    codigo: INVESTIGAR,
  },
  {
    id: 'cubrir-con-tests',
    file: 'cubrir-con-tests.js',
    titulo: 'Cubrir con tests lo más riesgoso',
    para: 'Un agente encuentra funciones sin tests y ordena por riesgo; después varios escriben los tests de las críticas.',
    ensena: ['fan-out despues de analizar', 'schema con enum', 'salida temprana'],
    agentes: '1 + hasta 5',
    codigo: TESTS,
  },
];

// Tutorial paso a paso. Cada paso muestra el minimo fragmento que hace falta,
// no un archivo entero.
const TUTORIAL = [
  {
    titulo: 'Qué es un workflow',
    texto: 'Un script que orquesta subagentes de forma determinista. Vos escribís el plan; cada agent() es un Claude aparte con su propio contexto, que hace su parte y devuelve un resultado. Sirve cuando la tarea se puede partir en pedazos independientes.',
    codigo: null,
    ojo: 'Si la tarea es una sola cosa secuencial, un workflow no aporta: cuesta más y tarda igual.',
  },
  {
    titulo: 'El bloque meta es obligatorio',
    texto: 'Va primero y tiene que ser literal: sin variables ni cálculos. De ahí sale el nombre que ves en la lista y la descripción del permiso al ejecutarlo.',
    codigo: `export const meta = {
  name: 'mi-workflow',
  description: 'Una línea sobre qué hace.',
  phases: [{ title: 'Hacer' }, { title: 'Revisar' }],
}`,
    ojo: 'Los títulos de phases tienen que coincidir exactamente con los que uses en phase().',
  },
  {
    titulo: 'Un agente',
    texto: 'agent(prompt, opciones) devuelve una promesa con lo que produjo. El label es lo que ves en el progreso; la phase lo ubica en el diagrama.',
    codigo: `phase('Hacer')

const r = await agent('Arreglá el bug de la fecha en src/util.js', {
  label: 'arreglar',
  phase: 'Hacer',
  effort: 'high',
})`,
    ojo: 'effort va de low a max. Para subagentes que solo leen, low alcanza y sale mucho más barato.',
  },
  {
    titulo: 'Pedir una respuesta con forma',
    texto: 'Con schema, el agente devuelve un objeto validado en vez de texto libre. Es lo que te permite usar el resultado en el paso siguiente sin parsear a mano.',
    codigo: `const SCHEMA = {
  type: 'object',
  properties: {
    archivos: { type: 'array', items: { type: 'string' } },
    resumen: { type: 'string' },
  },
  required: ['resumen'],
}

const r = await agent('...', { label: 'x', schema: SCHEMA })
// r.resumen y r.archivos ya vienen tipados`,
    ojo: 'Sin schema tenés que interpretar prosa, y ahí es donde se rompen los workflows.',
  },
  {
    titulo: 'parallel: todos a la vez',
    texto: 'Corre varias funciones al mismo tiempo y espera a que terminen todas. Usalo cuando el paso siguiente necesita el conjunto completo.',
    codigo: `const partes = await parallel([
  () => agent('Angulo A', { label: 'a' }),
  () => agent('Angulo B', { label: 'b' }),
  () => agent('Angulo C', { label: 'c' }),
])`,
    ojo: 'Se pasan funciones (() => agent(...)), no promesas. Si pasás agent(...) directo, arrancan antes de que parallel las controle.',
  },
  {
    titulo: 'pipeline: cada uno sigue apenas puede',
    texto: 'Toma una lista, corre la primera etapa por cada item, y encadena la segunda en cuanto ese item está listo — sin esperar a los demás. Es la diferencia entre esperar al más lento y no esperarlo.',
    codigo: `const resultados = await pipeline(
  DIMENSIONES,
  (d) => agent(d.prompt, { label: 'revisar:' + d.key, schema: HALLAZGOS }),
  (revision) => parallel(
    revision.findings.map((f) => () =>
      agent('Verificá: ' + f.title, { label: 'verificar', schema: VEREDICTO })
    )
  )
)`,
    ojo: 'Con parallel, la verificación de la dimensión rápida esperaría a la lenta. Con pipeline, no.',
  },
  {
    titulo: 'Recibir parámetros',
    texto: 'args es lo que se le pasa al invocarlo. Validalo al principio y cortá con un error claro si falta algo: es más barato que descubrirlo con cinco agentes ya corriendo.',
    codigo: `const tarea = (args && args.tarea) || ''
if (!tarea) throw new Error('Falta args.tarea')

const n = Math.max(1, Math.min(6, (args && args.cantidad) || 1))`,
    ojo: 'Poné un techo a las cantidades que vengan de args. Sin el Math.min, un 500 por error lanza 500 agentes.',
  },
  {
    titulo: 'Devolver el resultado',
    texto: 'Lo que retorna el script es lo que queda como salida del workflow. Devolvé lo procesado, no todo el crudo.',
    codigo: `const confirmados = todos.filter((f) => f.veredicto.esReal)
return { confirmados, descartados: todos.length - confirmados.length }`,
    ojo: 'Si devolvés los objetos completos de cada agente, la salida se vuelve ilegible.',
  },
];

module.exports = { PLANTILLAS, TUTORIAL };
