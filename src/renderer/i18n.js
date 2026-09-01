// Traduccion de los valores que vienen en ingles desde Claude Code y desde la
// API. Solo se traduce lo que es vocabulario cerrado y conocido; si aparece un
// valor nuevo se muestra tal cual en vez de inventar una traduccion.
//
// NO se traducen: nombres de herramientas (Bash, Read), eventos de hook
// (PreToolUse), lenguajes, ni las descripciones de skills de terceros — cambiar
// el texto de otro autor seria tergiversarlo.

const OUTCOME = {
  achieved: 'logrado',
  mostly_achieved: 'casi logrado',
  partially_achieved: 'a medias',
  not_achieved: 'no logrado',
  abandoned: 'abandonado',
  unclear: 'poco claro',
};

const HELPFULNESS = {
  very_helpful: 'muy útil',
  helpful: 'útil',
  somewhat_helpful: 'algo útil',
  not_helpful: 'poco útil',
  harmful: 'contraproducente',
};

const SESSION_TYPE = {
  iterative_refinement: 'refinamiento iterativo',
  single_task: 'tarea puntual',
  multi_task: 'varias tareas',
  exploration: 'exploración',
  debugging: 'depuración',
  question_answering: 'preguntas y respuestas',
  code_review: 'revisión de código',
  learning: 'aprendizaje',
};

const FRICTION = {
  incomplete_solution: 'solución incompleta',
  tool_limit: 'límite de herramientas',
  tool_errors: 'errores de herramientas',
  misunderstanding: 'malentendido',
  repeated_correction: 'correcciones repetidas',
  context_loss: 'pérdida de contexto',
  slow_response: 'respuesta lenta',
  wrong_approach: 'enfoque equivocado',
  permission_denied: 'permiso denegado',
  user_interruption: 'interrupción',
  hallucination: 'dato inventado',
  scope_creep: 'alcance desbordado',
};

const GOAL_CATEGORY = {
  learning_and_explanation: 'aprender y entender',
  content_generation: 'generar contenido',
  documentation: 'documentación',
  question_answering: 'responder preguntas',
  codebase_explanation: 'explicar el código',
  tooling_configuration: 'configurar herramientas',
  documentation_review: 'revisar documentación',
  debugging: 'depurar',
  feature_development: 'desarrollar una función',
  refactoring: 'refactorizar',
  testing: 'testing',
  data_analysis: 'analizar datos',
};

const SEAT_TIER = {
  team_standard: 'Team (estándar)',
  team_premium: 'Team (premium)',
  enterprise: 'Enterprise',
  pro: 'Pro',
  max: 'Max',
  free: 'Gratuito',
};

const BILLING = {
  stripe_subscription: 'suscripción (Stripe)',
  invoice: 'facturación',
  none: 'sin facturación',
};

const ORG_TYPE = {
  claude_team: 'equipo de Claude',
  claude_enterprise: 'Claude Enterprise',
  personal: 'personal',
};

const CREDITS_REASON = {
  out_of_credits: 'sin créditos disponibles',
  user_disabled: 'desactivados por vos',
  spend_limit_reached: 'llegaste al tope de gasto',
  not_eligible: 'no disponibles en tu plan',
  never_enabled: 'nunca se activaron',
};

// Descripciones de modelos que Claude Code guarda en ingles.
const MODEL_BLURB = [
  [/most capable for your hardest and longest-running tasks/i,
    'El más capaz, para tus tareas más difíciles y más largas'],
  [/draws from usage credits/i, 'consume créditos de uso extra'],
  [/best for (most|everyday) (tasks|work)/i, 'el mejor para el trabajo de todos los días'],
  [/fastest( model)?/i, 'el más rápido'],
];

function pick(map, key, fallback) {
  if (key == null || key === '') return fallback === undefined ? '—' : fallback;
  return map[String(key)] || String(key).replace(/_/g, ' ');
}

export const esOutcome = (v) => pick(OUTCOME, v);
export const esHelpfulness = (v) => pick(HELPFULNESS, v);
export const esSessionType = (v) => pick(SESSION_TYPE, v);
export const esFriction = (v) => pick(FRICTION, v);
export const esGoalCategory = (v) => pick(GOAL_CATEGORY, v);
export const esSeatTier = (v) => pick(SEAT_TIER, v);
export const esBilling = (v) => pick(BILLING, v);
export const esOrgType = (v) => pick(ORG_TYPE, v);
export const esCreditsReason = (v) => pick(CREDITS_REASON, v);

// Traduce la descripcion de un modelo respetando el separador con puntos.
export function esModelBlurb(text) {
  if (!text) return null;
  return String(text)
    .split(/\s*·\s*/)
    .map((part) => {
      for (const [re, es] of MODEL_BLURB) if (re.test(part)) return es;
      return part;
    })
    .join(' · ');
}
