// ============================================================
// Edge Function "chat" — El Coach de la app ONIX
// ------------------------------------------------------------
// - Recibe el historial de chat desde la app (usuario autenticado).
// - Llama a la API de Anthropic con herramientas que leen/escriben
//   la base de datos (semana, rutinas, plan, objetivos, macros, comidas,
//   perfil) COMO EL USUARIO (client con su JWT → RLS normal, sin service role).
// - La ANTHROPIC_API_KEY vive como secret de la función, nunca
//   llega al navegador.
// - Responde EN DIRECTO (NDJSON): el texto se va escribiendo.
// - El PERFIL se lee de `profiles`: NADA escrito a fuego (spec del Coach §2).
// - PRIMERA SESIÓN (spec §3): mientras profiles.first_session_done sea false,
//   esta conversación es la que deja montado el plan entero.
// - PROMPT CACHING: el prompt va partido en dos bloques (uno fijo para todo el
//   mundo y otro con el contexto del usuario) y las herramientas llevan su
//   propio punto de caché. En un bucle agéntico de varias rondas se reenvían
//   herramientas + prompt en cada vuelta: cacheados, esas rondas cuestan ~10%.
// - TOPES DE USO (../_shared/ai_usage.ts): se miran ANTES de la primera
//   llamada; al llegar al tope se responde con un evento `limit` (la app saca
//   su ventana de tope) y no se llama a la API. Una respuesta ya empezada
//   nunca se corta por los topes.
//   Cada ronda deja su usage (tokens y caché) en ai_usage.
// - DÓNDE ESTÁ EN SU PLAN: el bloque actual se calcula SIEMPRE por fecha a
//   partir de plan.blocks (startDate/endDate); plan.current_block es solo una
//   copia que se re-guarda si ha cambiado. Antes se fijaba al crear el plan y
//   se quedaba congelado.
// - BÚSQUEDA WEB (server tool, max 2 por mensaje): solo para confirmar datos de
//   eventos reales. Cada búsqueda deja una fila 'coach_search' en ai_usage.
// Deploy: MCP de Supabase o `supabase functions deploy chat`.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkLimits, logUsage, logSearches } from '../_shared/ai_usage.ts';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// El Coach razona y escribe el plan entero: aquí mandan las neuronas. Se
// cambia con el secret CHAT_MODEL, que es SOLO del Coach: la nutrición tiene
// el suyo propio (NUTRITION_MODEL), más barato.
const MODEL = Deno.env.get('CHAT_MODEL') ?? 'claude-opus-5';
const MAX_TOOL_ROUNDS = 12;
// Alto a propósito: en la primera sesión escribe varios entrenos de una tacada
// y con 2048 se quedaba a medias una llamada a herramienta.
const MAX_TOKENS = 16000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- Fechas (sin dependencias, todo en UTC para no bailar de día) ----------
const diaSemana = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay();
const masDias = (iso: string, n: number) =>
  new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400_000).toISOString().slice(0, 10);
const lunesDe = (iso: string) => masDias(iso, diaSemana(iso) === 0 ? -6 : 1 - diaSemana(iso));
const esFecha = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const diasEntre = (a: string, b: string) =>
  Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400_000);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (iso: string) => `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1]}`;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ---------- Dónde está en su plan (misma cuenta que la app: planStatus) ----------
// Bloques en camelCase (startDate/endDate), tal como los guarda set_plan.
function estadoPlan(plan: any, hoy: string) {
  const blocks = (Array.isArray(plan?.blocks) ? plan.blocks : [])
    .filter((b: any) => esFecha(b?.startDate) && esFecha(b?.endDate));
  if (!blocks.length) return null;
  const ini = esFecha(plan.start_date) ? plan.start_date : blocks[0].startDate;
  const fin = blocks[blocks.length - 1].endDate;
  const idx = blocks.findIndex((b: any) => hoy >= b.startDate && hoy <= b.endDate);
  const deadline = plan?.goals?.shortTerm?.deadline;
  return {
    blocks, ini, fin, idx,
    bloque: idx >= 0 ? blocks[idx] : null,
    semana: Math.floor(diasEntre(ini, hoy) / 7) + 1,
    semanas: Math.ceil((diasEntre(ini, fin) + 1) / 7),
    caducado: hoy > fin,
    antes: hoy < ini,
    deadline: esFecha(deadline) ? deadline : null,
    faltan: esFecha(deadline) && deadline >= hoy ? diasEntre(hoy, deadline) : null,
  };
}
const nombreBloque = (cb: any) => (typeof cb === 'string' ? cb : cb?.name ?? null);

// Re-guarda plan.current_block si el que toca por fecha es otro. Con el plan
// caducado (hoy fuera de todos los bloques) no se toca: eso lo dice el Coach y
// lo marca diagnostico_datos().
async function sincronizaBloque(sb: any, planId: number, currentBlock: any, est: any) {
  if (!est?.bloque) return;
  if (nombreBloque(currentBlock) === est.bloque.name) return;
  const { error } = await sb.from('plan').update({ current_block: est.bloque.name }).eq('id', planId);
  if (error) console.error('current_block', error.message);
}

// ¿Rutina de cardio? Por etiqueta o nombre, o porque todos sus ejercicios lo son.
const RE_CARDIO = /carrera|correr|running|rodaje|bici|cardio|tirada|trote|nadar|nataci/i;

const BLOQUES: Record<string, string> = {
  breakfast: 'desayuno', lunch: 'comida', dinner: 'cena', other: 'otros',
};

// ---------- Herramientas expuestas a Claude ----------
// Búsqueda web: herramienta de SERVIDOR (la ejecuta Anthropic, no runTool).
// Variante básica: la de filtrado dinámico mete bloques de ejecución de código
// en el stream y aquí no hacen falta.
const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };
const TOOLS = [
  WEB_SEARCH,
  {
    name: 'get_week',
    description:
      'Devuelve el calendario efectivo de una semana (rutina asignada a cada día, 0=domingo..6=sábado), combinando el plan base con los ajustes de esa semana. Llamar antes de modificar una semana concreta.',
    input_schema: {
      type: 'object',
      properties: {
        week_start: { type: 'string', description: 'Lunes de la semana en formato YYYY-MM-DD' },
      },
      required: ['week_start'],
    },
  },
  {
    name: 'set_day',
    description:
      'Cambia la rutina de UN día de UNA semana concreta (un apaño puntual: viaje, lesión, imprevisto). Usar "rest" para descanso. NO cambia el plan: para eso está set_weekly_schedule.',
    input_schema: {
      type: 'object',
      properties: {
        week_start: { type: 'string', description: 'Lunes de la semana, YYYY-MM-DD' },
        day_of_week: { type: 'integer', description: '0=domingo, 1=lunes, ... 6=sábado' },
        routine_id: { type: 'string', description: 'id de la rutina (p.ej. full-body-a, outdoor, rest)' },
      },
      required: ['week_start', 'day_of_week', 'routine_id'],
    },
  },
  {
    name: 'set_weekly_schedule',
    description:
      'Fija el CALENDARIO BASE del usuario: qué entreno le toca cada día de la semana, todas las semanas. Es lo que hace que su pantalla de inicio deje de decir REST. Manda los siete días. Los ajustes sueltos de las semanas próximas se borran para que mande este calendario.',
    input_schema: {
      type: 'object',
      properties: {
        schedule: {
          type: 'object',
          description: 'Objeto con los siete días. Claves "0" (domingo) a "6" (sábado); valores: id de rutina existente o "rest". Ejemplo: {"0":"rest","1":"fuerza-a","2":"rest","3":"fuerza-b","4":"rest","5":"cardio","6":"rest"}',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['schedule'],
    },
  },
  {
    name: 'get_routine',
    description: 'Devuelve una rutina completa con sus ejercicios, series, reps y descansos.',
    input_schema: {
      type: 'object',
      properties: { routine_id: { type: 'string' } },
      required: ['routine_id'],
    },
  },
  {
    name: 'list_routines',
    description: 'Lista los entrenos que tiene el usuario ahora mismo (id, nombre, etiqueta y número de ejercicios). Consultar antes de tocar o crear entrenos, para no duplicar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'upsert_routine',
    description:
      'Crea o actualiza un entreno completo (reemplaza su lista de ejercicios). Los exercise_id deben existir en el catálogo — usar list_exercises para comprobar y add_exercise si falta alguno. Un entreno de cardio (carrera, bici, tirada…) no lleva ejercicios de fuerza, y un ejercicio no se repite salvo que su nota explique por qué (p. ej. "segunda vuelta del circuito"). Si algo no cuadra, la herramienta devuelve un error: corrígelo y vuelve a llamarla. Las notas explican CÓMO hacer el ejercicio, no una progresión por semanas (eso va en los bloques del plan). La app del usuario se actualiza en tiempo real al guardar.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'kebab-case, p.ej. "hotel-mancuernas"' },
        name: { type: 'string' },
        tag: { type: 'string', description: 'Etiqueta corta, máximo 5 caracteres, p.ej. "HTL"' },
        muscle_groups: { type: 'array', items: { type: 'string' }, description: 'En español, para mostrar en la app' },
        optional: { type: 'boolean', description: 'true si es un entreno opcional, que no cuenta para el objetivo semanal' },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              exercise_id: { type: 'string' },
              sets: { type: 'integer' },
              reps_target: { type: 'string', description: 'p.ej. "8-10", "40-60s", "max"' },
              rest_sec: { type: 'integer' },
              notes: { type: 'string', description: 'Nota técnica breve para el usuario' },
              superset_group: { type: 'integer', description: 'Mismo número = mismo superserie/circuito' },
            },
            required: ['exercise_id', 'sets', 'reps_target', 'rest_sec'],
          },
        },
      },
      required: ['id', 'name', 'tag', 'muscle_groups', 'exercises'],
    },
  },
  {
    name: 'list_exercises',
    description: 'Lista el catálogo de ejercicios (id, nombre, grupo muscular, equipamiento). Filtrable por grupo.',
    input_schema: {
      type: 'object',
      properties: {
        muscle_group: {
          type: 'string',
          description: 'Opcional: chest|back|shoulders|biceps|triceps|quads|hamstrings|glutes|calves|core',
        },
      },
    },
  },
  {
    name: 'add_exercise',
    description: 'Añade un ejercicio nuevo al catálogo maestro. Solo si no existe uno equivalente.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'kebab-case único' },
        name: { type: 'string', description: 'Nombre en español' },
        muscle_group: { type: 'string' },
        pattern: { type: 'string' },
        equipment: { type: 'string', description: 'barbell|dumbbell|machine|cable|bodyweight|other' },
      },
      required: ['id', 'name', 'muscle_group', 'equipment'],
    },
  },
  {
    name: 'set_goals',
    description:
      'Escribe los objetivos del usuario, que salen en la pestaña Objetivos de su app. Dos bloques: corto plazo (semanas o pocos meses) y largo plazo (un año). Manda solo el que quieras cambiar. Cada objetivo es una línea corta y medible; nada de párrafos.',
    input_schema: {
      type: 'object',
      properties: {
        short_term: {
          type: 'object',
          description: 'Objetivos de corto plazo',
          properties: {
            horizon: { type: 'string', description: 'p.ej. "12 semanas"' },
            deadline: { type: 'string', description: 'YYYY-MM-DD' },
            targets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  metric: { type: 'string', description: 'Nombre corto: Adherencia, Grasa corporal, Press banca, Dominadas…' },
                  target: { type: 'string', description: 'La meta. Si conoces el punto de partida, escríbelo como "20,9% → 18,5%": la app lo parte en DESDE y META' },
                  notes: { type: 'string', description: 'Una frase corta de cómo se consigue' },
                  progress: { type: 'number', description: '0-100, cuánto lleva cumplido. Al crearlo, 0' },
                },
                required: ['metric', 'target'],
              },
            },
          },
        },
        long_term: {
          type: 'object',
          description: 'Objetivos de largo plazo, mismo formato que short_term',
          properties: {
            horizon: { type: 'string' },
            deadline: { type: 'string' },
            targets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  metric: { type: 'string' },
                  target: { type: 'string' },
                  notes: { type: 'string' },
                  progress: { type: 'number' },
                },
                required: ['metric', 'target'],
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'set_plan',
    description:
      'Escribe el plan de entrenamiento por fases (mesociclos), que es lo que pinta la pestaña Programa de la app. Da el nombre del plan, sus fechas y los bloques en orden. Es la ÚNICA fuente de verdad de la progresión semana a semana. Reglas que comprueba la herramienta: bloques contiguos y sin solapes (cada uno empieza el día siguiente al fin del anterior), el último llega hasta la fecha límite de los objetivos de corto plazo, y cada día del calendario semanal apunta a un entreno que existe. Si falla, devuelve un error: corrígelo y vuelve a llamarla.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'p.ej. "Plan de vuelta, septiembre-noviembre"' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string', description: 'Dos o tres frases sobre la idea del plan' },
        blocks: {
          type: 'array',
          description: 'Fases en orden cronológico',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'p.ej. "Adaptación"' },
              weeks: { type: 'integer', description: 'Duración en semanas' },
              start_date: { type: 'string', description: 'YYYY-MM-DD' },
              end_date: { type: 'string', description: 'YYYY-MM-DD' },
              scheme: { type: 'string', description: 'Esquema en pocas palabras: "3 días, full body, RPE 7"' },
              focus: { type: 'string', description: 'Una frase con el foco de la fase' },
            },
            required: ['name', 'weeks', 'start_date', 'end_date'],
          },
        },
      },
      required: ['name', 'blocks'],
    },
  },
  {
    name: 'get_history',
    description:
      'Devuelve los entrenamientos registrados en los últimos N días, con ejercicios, series, kilos y reps. Para analizar progreso o responder "cómo voy".',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Por defecto 30' } },
    },
  },
  {
    name: 'get_previous_plans',
    description:
      'Devuelve los planes y entrenos ANTERIORES del usuario, los que quedaron archivados al rehacer el plan. Útil para no repetir lo que no le funcionó y para saber de dónde viene.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_profile',
    description:
      'Guarda datos de la ficha del usuario cuando los averigües conversando. Envía SOLO los campos que quieras cambiar. Guarda lo que te digan, no lo que supongas.',
    input_schema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: 'Cómo quiere que le llames' },
        sex: { type: 'string', description: 'hombre | mujer' },
        birth_date: { type: 'string', description: 'Fecha de nacimiento, YYYY-MM-DD' },
        height_cm: { type: 'number' },
        weight_kg: { type: 'number' },
        goals: {
          type: 'array', items: { type: 'string' },
          description: 'Varios: perder-grasa | ganar-musculo | recomposicion | salud-forma | mejorar-entrenos | competicion',
        },
        experience: { type: 'string', description: 'novato | intermedio | avanzado' },
        equipment: {
          type: 'array', items: { type: 'string' },
          description: 'Dónde puede entrenar: gimnasio, casa, exterior, deporte',
        },
        training_days: { type: 'integer', description: 'Días que puede entrenar por semana' },
      },
    },
  },
  {
    name: 'get_macros',
    description:
      'Devuelve los objetivos de macros del usuario. Pueden ser dos juegos: uno para días de entreno y otro para días de descanso. Consultar SIEMPRE antes de cambiarlos.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_macros',
    description:
      'Fija los objetivos de macros. Se pueden dar los dos juegos (training y rest) o solo uno; el que no se envíe se queda como estaba. La app elige automáticamente cuál mostrar según si ese día hay entreno. Las kcal se calculan solas si no se envían.',
    input_schema: {
      type: 'object',
      properties: {
        training: {
          type: 'object',
          description: 'Objetivos para los días con entrenamiento',
          properties: {
            protein_g: { type: 'number' }, carbs_g: { type: 'number' },
            fat_g: { type: 'number' }, fiber_g: { type: 'number' }, kcal: { type: 'number' },
          },
        },
        rest: {
          type: 'object',
          description: 'Objetivos para los días de descanso',
          properties: {
            protein_g: { type: 'number' }, carbs_g: { type: 'number' },
            fat_g: { type: 'number' }, fiber_g: { type: 'number' }, kcal: { type: 'number' },
          },
        },
      },
    },
  },
  {
    name: 'get_meals',
    description:
      'Devuelve LO QUE HA COMIDO el usuario: un día suelto o un rango de días. Por cada día trae el detalle de las comidas (bloque, descripción y macros), los totales del día y el objetivo que le tocaba ESE día (el de entreno o el de descanso, según si entrenó). Consultar SIEMPRE antes de opinar sobre su dieta, decirle cuánto le falta o proponerle una cena: nunca supongas lo que ha comido.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Un día concreto, YYYY-MM-DD. Si no envías nada ni rango, se entiende HOY.' },
        from: { type: 'string', description: 'Primer día del rango, YYYY-MM-DD. Para varios días usa from y to.' },
        to: { type: 'string', description: 'Último día del rango, YYYY-MM-DD (incluido). Máximo 31 días de rango.' },
      },
    },
  },
  {
    name: 'log_meal',
    description:
      'Apunta UNA comida en el diario de Nutrición del usuario. Úsala cuando te cuente lo que ha comido y quiera registrarlo. Un plato o alimento por llamada: si te dice "pollo con arroz y una manzana", haz varias llamadas. Los macros los estimas TÚ, con raciones realistas; si no dice la cantidad, estima una normal para él y escríbela entre paréntesis en la descripción. Si no tienes claro qué era o cuánto, pregúntale antes de inventar. Aparece en su pantalla de Nutrición.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Nombre corto del plato o alimento en español con la cantidad entre paréntesis. Ej: "Pechuga de pollo a la plancha (200 g)"' },
        meal_type: { type: 'string', description: 'Bloque del día: breakfast (desayuno) | lunch (comida) | dinner (cena) | other (snacks, batidos, picoteo). Si no lo dice, dedúcelo por lo que ha comido y la hora que sea.' },
        date: { type: 'string', description: 'Día al que va la comida, YYYY-MM-DD. Por defecto HOY. No se puede apuntar en el futuro.' },
        protein_g: { type: 'number', description: 'Proteína en gramos' },
        carbs_g: { type: 'number', description: 'Hidratos en gramos' },
        fat_g: { type: 'number', description: 'Grasa en gramos' },
        fiber_g: { type: 'number', description: 'Fibra en gramos' },
        kcal: { type: 'number', description: 'Calorías del plato. Si no las mandas se calculan con los macros.' },
      },
      required: ['description', 'meal_type', 'protein_g', 'carbs_g', 'fat_g'],
    },
  },
  {
    name: 'finish_first_session',
    description:
      'Cierra la primera sesión: marca que el usuario ya tiene su plan montado y desbloquea el chat normal. Llamar SOLO al final, cuando ya has escrito objetivos, entrenos, calendario y macros (con set_macros). Si falta algo, la herramienta te lo dirá y no se marcará.',
    input_schema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Solo si el usuario dice expresamente que ahora no quiere plan: cierra la sesión sin haber montado nada, para no dejarle el chat bloqueado.' },
      },
    },
  },
];

// Punto de caché en la ÚLTIMA herramienta: el bloque entero de herramientas
// (que es lo más gordo y nunca cambia) se cachea para todas las rondas y para
// todos los usuarios.
const TOOLS_CACHEADAS = TOOLS.map((t, i) =>
  (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));

// ---------- Ejecución de herramientas (con el client RLS del usuario) ----------
async function planActivo(sb: any) {
  const { data } = await sb.from('plan')
    .select('id, goals, weekly_schedule, start_date, end_date').eq('status', 'active').limit(1).maybeSingle();
  return data;
}

// ---------- Validaciones: si fallan, el modelo recibe el error y corrige ----------
async function validaRutina(sb: any, input: any): Promise<string[]> {
  const fallos: string[] = [];
  const exs: any[] = Array.isArray(input.exercises) ? input.exercises : [];
  if (!exs.length) return ['el entreno no tiene ejercicios'];
  const ids = [...new Set(exs.map((e) => String(e.exercise_id ?? '')))];
  const { data: cat, error } = await sb.from('exercises').select('id, name, log_type').in('id', ids);
  if (error) throw error;
  const porId: Record<string, any> = {};
  (cat ?? []).forEach((e: any) => { porId[e.id] = e; });
  const faltan = ids.filter((id) => !porId[id]);
  if (faltan.length) {
    fallos.push(`no existen en el catálogo: ${faltan.join(', ')} (búscalos con list_exercises o créalos con add_exercise)`);
  }
  const conocidos = exs.filter((e) => porId[e.exercise_id]);
  const todoCardio = conocidos.length > 0 && conocidos.every((e) => porId[e.exercise_id].log_type === 'cardio');
  const esCardio = RE_CARDIO.test(`${input.tag ?? ''} ${input.name ?? ''} ${input.id ?? ''}`) || todoCardio;
  if (esCardio) {
    const fuerza = conocidos.filter((e) => porId[e.exercise_id].log_type === 'fuerza');
    if (fuerza.length) {
      fallos.push(`es un entreno de cardio y lleva ejercicios de fuerza: ${fuerza.map((e) => `${e.exercise_id} (${porId[e.exercise_id].name})`).join(', ')}. Para la sesión de cardio usa ejercicios de cardio (p. ej. running-outdoor o cardio-steady)`);
    }
  }
  // Repetidos: solo si la nota de la repetición lo justifica
  const vistos = new Set<string>();
  const JUSTIFICA = /repet|otra vez|segunda|tercera|de nuevo|vuelta|ronda|circuito|finisher|bis\b|calent|calma|enfri|serie|interval|fartlek|progresiv/i;
  const repes: string[] = [];
  exs.forEach((e) => {
    const id = String(e.exercise_id ?? '');
    if (vistos.has(id) && !JUSTIFICA.test(String(e.notes ?? ''))) repes.push(id);
    vistos.add(id);
  });
  if (repes.length) {
    fallos.push(`ejercicios repetidos sin explicación: ${[...new Set(repes)].join(', ')}. Quita la repetición o explica en notes por qué va dos veces (p. ej. "segunda vuelta del circuito", o en carrera "calentamiento" / "series" / "vuelta a la calma"). Si son sesiones de días distintos, haz un entreno por día`);
  }
  return fallos;
}

async function validaPlan(sb: any, blocks: any[], p: any): Promise<string[]> {
  const fallos: string[] = [];
  if (!blocks.length) return ['el plan no tiene bloques'];
  blocks.forEach((b, i) => {
    if (!esFecha(b.startDate) || !esFecha(b.endDate)) fallos.push(`el bloque ${i + 1} ("${b.name}") necesita start_date y end_date en YYYY-MM-DD`);
    else if (b.endDate < b.startDate) fallos.push(`el bloque ${i + 1} ("${b.name}") acaba antes de empezar`);
  });
  if (fallos.length) return fallos;
  for (let i = 1; i < blocks.length; i++) {
    const esperado = masDias(blocks[i - 1].endDate, 1);
    if (blocks[i].startDate < esperado) {
      fallos.push(`"${blocks[i].name}" (empieza ${blocks[i].startDate}) se solapa con "${blocks[i - 1].name}" (acaba ${blocks[i - 1].endDate})`);
    } else if (blocks[i].startDate > esperado) {
      fallos.push(`hay un hueco entre "${blocks[i - 1].name}" (acaba ${blocks[i - 1].endDate}) y "${blocks[i].name}" (empieza ${blocks[i].startDate}); debería empezar el ${esperado}`);
    }
  }
  const deadline = p?.goals?.shortTerm?.deadline;
  const ultimo = blocks[blocks.length - 1];
  if (esFecha(deadline) && ultimo.endDate < deadline) {
    fallos.push(`el último bloque acaba el ${ultimo.endDate} y la fecha límite de los objetivos de corto plazo es el ${deadline}: alarga el plan hasta ahí (o cambia la fecha con set_goals si la meta ha cambiado)`);
  }
  const sched: Record<string, string> = p?.weekly_schedule ?? {};
  const usados = [...new Set(Object.values(sched).filter((v) => v && v !== 'rest'))];
  if (usados.length) {
    const { data: rs } = await sb.from('routines').select('id').eq('archived', false).in('id', usados);
    const hay = new Set((rs ?? []).map((r: any) => r.id));
    const malos = Object.entries(sched).filter(([, v]) => v && v !== 'rest' && !hay.has(v));
    if (malos.length) {
      fallos.push(`el calendario semanal apunta a entrenos que no existen o están archivados: ${malos.map(([d, v]) => `${DIAS[Number(d)] ?? d} → ${v}`).join(', ')}. Créalos con upsert_routine o cambia el calendario con set_weekly_schedule`);
    }
  }
  return fallos;
}
function limpiaObjetivos(bloque: any) {
  return {
    horizon: bloque.horizon ?? '',
    deadline: bloque.deadline ?? null,
    targets: (bloque.targets ?? []).map((t: any) => ({
      metric: t.metric,
      target: t.target,
      notes: t.notes ?? '',
      progress: Number(t.progress) || 0,
    })),
  };
}

const kcalDe = (m: any) => (m?.kcal
  ? Math.round(m.kcal)
  : Math.round((m?.protein_g ?? 0) * 4 + (m?.carbs_g ?? 0) * 4 + (m?.fat_g ?? 0) * 9));

// Los macros pueden venir en dos juegos {training, rest} o planos (formato
// antiguo, un solo juego que vale para los dos tipos de día). Igual que la app.
function macrosPorTipo(goals: any) {
  const n = (goals ?? {}).nutrition ?? {};
  if (n.training || n.rest) {
    return { entreno: n.training ?? n.rest ?? {}, descanso: n.rest ?? n.training ?? {}, dual: true };
  }
  return { entreno: n, descanso: n, dual: false };
}

// ¿Ese día cuenta como día de entreno? MISMA regla que la app (window.appIsTrainingDay):
//  · si hay sesión registrada ese día → ENTRENO (aunque tocara descanso)
//  · si el día YA TERMINÓ y no entrenó → DESCANSO (aunque estuviera planificado)
//  · hoy y días futuros → lo que diga el calendario
async function diasDeEntreno(sb: any, desde: string, hasta: string, hoy: string) {
  const [{ data: hechos }, { data: plan }, { data: ovr }] = await Promise.all([
    sb.from('workouts').select('date').gte('date', desde).lte('date', hasta),
    sb.from('plan').select('weekly_schedule').eq('status', 'active').limit(1).maybeSingle(),
    sb.from('week_overrides').select('*').gte('week_start', lunesDe(desde)).lte('week_start', lunesDe(hasta)),
  ]);
  const entrenados = new Set((hechos ?? []).map((w: any) => w.date));
  const base: Record<string, string> = plan?.weekly_schedule ?? {};
  const apanos: Record<string, string> = {};
  (ovr ?? []).forEach((o: any) => { apanos[`${o.week_start}|${o.day_of_week}`] = o.routine_id ?? 'rest'; });
  return (iso: string) => {
    if (entrenados.has(iso)) return true;
    if (iso < hoy) return false;
    const rid = apanos[`${lunesDe(iso)}|${diaSemana(iso)}`] ?? base[String(diaSemana(iso))] ?? 'rest';
    return !!rid && rid !== 'rest';
  };
}

function totalesDe(comidas: any[]) {
  const t: any = { protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, kcal: 0 };
  comidas.forEach((m) => { Object.keys(t).forEach((k) => { t[k] += Number(m[k]) || 0; }); });
  Object.keys(t).forEach((k) => { t[k] = Math.round(t[k] * 10) / 10; });
  return t;
}
function faltaPara(objetivo: any, totales: any) {
  const f: any = {};
  ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'kcal'].forEach((k) => {
    if (objetivo?.[k] !== undefined && objetivo?.[k] !== null) {
      f[k] = Math.round(((Number(objetivo[k]) || 0) - (Number(totales[k]) || 0)) * 10) / 10;
    }
  });
  return f;
}

// Resumen de un día de comidas: lo usan get_meals y log_meal (para contarle al
// Coach cómo queda el día justo después de apuntar).
async function resumenDelDia(sb: any, iso: string, hoy: string) {
  const [{ data: comidas }, p] = await Promise.all([
    sb.from('meals').select('*').eq('date', iso).order('created_at'),
    planActivo(sb),
  ]);
  const esEntreno = (await diasDeEntreno(sb, iso, iso, hoy))(iso);
  const juegos = macrosPorTipo(p?.goals);
  const objetivo: any = { ...(esEntreno ? juegos.entreno : juegos.descanso) };
  if (Object.keys(objetivo).length && !objetivo.kcal) objetivo.kcal = kcalDe(objetivo);
  const totales = totalesDe(comidas ?? []);
  return {
    dia: iso,
    tipo_de_dia: esEntreno ? 'entreno' : 'descanso',
    comidas: (comidas ?? []).map((m: any) => ({
      bloque: BLOQUES[m.meal_type] ?? m.meal_type,
      descripcion: m.description,
      protein_g: Number(m.protein_g) || 0,
      carbs_g: Number(m.carbs_g) || 0,
      fat_g: Number(m.fat_g) || 0,
      fiber_g: Number(m.fiber_g) || 0,
      kcal: Number(m.kcal) || 0,
      apuntada_por: m.source === 'coach' ? 'el coach' : (m.source ?? 'la app'),
    })),
    totales,
    objetivo: Object.keys(objetivo).length ? objetivo : null,
    falta: Object.keys(objetivo).length ? faltaPara(objetivo, totales) : null,
  };
}

async function runTool(sb: any, name: string, input: any, userId: string, hoyIso: string): Promise<string> {
  try {
    switch (name) {
      case 'get_week': {
        const [{ data: plan }, { data: ovr }] = await Promise.all([
          sb.from('plan').select('weekly_schedule').eq('status', 'active').limit(1).maybeSingle(),
          sb.from('week_overrides').select('*').eq('week_start', input.week_start),
        ]);
        const sched: Record<string, string> = { ...(plan?.weekly_schedule ?? {}) };
        (ovr ?? []).forEach((o: any) => { sched[String(o.day_of_week)] = o.routine_id ?? 'rest'; });
        return JSON.stringify({ week_start: input.week_start, schedule: sched });
      }
      case 'set_day': {
        const { error } = await sb.from('week_overrides').upsert({
          week_start: input.week_start,
          day_of_week: input.day_of_week,
          routine_id: input.routine_id,
        });
        if (error) throw error;
        return JSON.stringify({ ok: true });
      }
      case 'set_weekly_schedule': {
        const p = await planActivo(sb);
        if (!p) return JSON.stringify({ error: 'no hay plan activo' });
        const { data: rs } = await sb.from('routines').select('id').eq('archived', false);
        const validos = new Set([...(rs ?? []).map((r: any) => r.id), 'rest']);
        const entrada = input.schedule ?? {};
        const sched: Record<string, string> = {};
        for (let d = 0; d < 7; d++) {
          const v = entrada[String(d)] ?? entrada[d] ?? 'rest';
          if (!validos.has(v)) {
            return JSON.stringify({
              error: `La rutina "${v}" no existe. Créala antes con upsert_routine.`,
              rutinas_disponibles: [...validos],
            });
          }
          sched[String(d)] = v;
        }
        const { error } = await sb.from('plan').update({ weekly_schedule: sched }).eq('id', p.id);
        if (error) throw error;
        // Que mande el calendario nuevo: fuera apaños de esta semana en adelante
        const lunes = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
        await sb.from('week_overrides').delete().gte('week_start', lunes);
        return JSON.stringify({ ok: true, schedule: sched });
      }
      case 'get_routine': {
        const [{ data: r }, { data: rex }] = await Promise.all([
          sb.from('routines').select('*').eq('id', input.routine_id).maybeSingle(),
          sb.from('routine_exercises').select('*').eq('routine_id', input.routine_id).order('position'),
        ]);
        if (!r) return JSON.stringify({ error: 'routine not found' });
        return JSON.stringify({ ...r, exercises: rex ?? [] });
      }
      case 'list_routines': {
        const [{ data: rs }, { data: rex }] = await Promise.all([
          sb.from('routines').select('id, name, tag, muscle_groups, optional').eq('archived', false),
          sb.from('routine_exercises').select('routine_id'),
        ]);
        const cuenta: Record<string, number> = {};
        (rex ?? []).forEach((x: any) => { cuenta[x.routine_id] = (cuenta[x.routine_id] ?? 0) + 1; });
        return JSON.stringify((rs ?? []).map((r: any) => ({ ...r, ejercicios: cuenta[r.id] ?? 0 })));
      }
      case 'upsert_routine': {
        const fallos = await validaRutina(sb, input);
        if (fallos.length) {
          return JSON.stringify({ error: 'El entreno no se ha guardado. Corrige esto y vuelve a llamar a upsert_routine: ' + fallos.join(' | ') });
        }
        const { error: e1 } = await sb.from('routines').upsert({
          id: input.id,
          name: input.name,
          tag: input.tag,
          muscle_groups: input.muscle_groups,
          optional: input.optional ?? false,
          archived: false,
        });
        if (e1) throw e1;
        const { error: e2 } = await sb.from('routine_exercises').delete().eq('routine_id', input.id);
        if (e2) throw e2;
        const rows = (input.exercises ?? []).map((ex: any, i: number) => ({
          routine_id: input.id,
          position: i + 1,
          exercise_id: ex.exercise_id,
          sets: ex.sets,
          reps_target: ex.reps_target,
          rest_sec: ex.rest_sec,
          notes: ex.notes ?? null,
          superset_group: ex.superset_group ?? null,
        }));
        const { error: e3 } = await sb.from('routine_exercises').insert(rows);
        if (e3) throw e3;
        return JSON.stringify({ ok: true, id: input.id });
      }
      case 'list_exercises': {
        let q = sb.from('exercises').select('id, name, muscle_group, equipment').order('id');
        if (input.muscle_group) q = q.eq('muscle_group', input.muscle_group);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify(data);
      }
      case 'add_exercise': {
        const { error } = await sb.from('exercises').upsert({
          id: input.id,
          name: input.name,
          muscle_group: input.muscle_group,
          pattern: input.pattern ?? null,
          equipment: input.equipment,
        });
        if (error) throw error;
        return JSON.stringify({ ok: true });
      }
      case 'set_goals': {
        const p = await planActivo(sb);
        if (!p) return JSON.stringify({ error: 'no hay plan activo' });
        const goals: any = { ...(p.goals ?? {}) };
        if (input.short_term) goals.shortTerm = limpiaObjetivos(input.short_term);
        if (input.long_term) goals.longTerm = limpiaObjetivos(input.long_term);
        const { error } = await sb.from('plan').update({ goals }).eq('id', p.id);
        if (error) throw error;
        return JSON.stringify({ ok: true });
      }
      case 'set_plan': {
        const p = await planActivo(sb);
        if (!p) return JSON.stringify({ error: 'no hay plan activo' });
        // La app lee los bloques en camelCase; la herramienta los pide en snake_case
        const blocks = (input.blocks ?? []).map((b: any) => ({
          name: b.name,
          weeks: Number(b.weeks) || 0,
          startDate: b.start_date ?? null,
          endDate: b.end_date ?? null,
          scheme: b.scheme ?? '',
          focus: b.focus ?? '',
        }));
        const fallos = await validaPlan(sb, blocks, p);
        if (fallos.length) {
          return JSON.stringify({ error: 'El plan no se ha guardado. Corrige esto y vuelve a llamar a set_plan: ' + fallos.join(' | ') });
        }
        const parche: any = { name: input.name, blocks };
        if (input.start_date) parche.start_date = input.start_date;
        // El plan acaba donde acaba su último bloque: una sola fecha, no dos.
        parche.end_date = blocks[blocks.length - 1].endDate;
        if (input.notes) parche.notes = input.notes;
        // Bloque actual POR FECHA (antes: siempre el primero, y ahí se quedaba)
        const est = estadoPlan({ ...p, ...parche }, hoyIso);
        parche.current_block = est?.bloque?.name ?? (est?.antes ? blocks[0].name : null);
        const { error } = await sb.from('plan').update(parche).eq('id', p.id);
        if (error) throw error;
        return JSON.stringify({
          ok: true, bloques: blocks.length,
          bloque_actual: parche.current_block,
          semana: est ? `${est.semana} de ${est.semanas}` : null,
        });
      }
      case 'get_history': {
        const days = input.days ?? 30;
        const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
        const { data: workouts, error } = await sb
          .from('workouts').select('*').gte('date', since).order('date', { ascending: false });
        if (error) throw error;
        const ids = (workouts ?? []).map((w: any) => w.id);
        let sets: any[] = [];
        if (ids.length) {
          const { data } = await sb
            .from('workout_sets').select('*').in('workout_id', ids)
            .order('slot_index').order('set_index');
          sets = data ?? [];
        }
        return JSON.stringify({
          workouts: (workouts ?? []).map((w: any) => ({
            date: w.date,
            routine_id: w.routine_id,
            duration_min: w.duration_sec ? Math.round(w.duration_sec / 60) : null,
            sets: sets.filter((s) => s.workout_id === w.id).map((s) => ({
              exercise_id: s.exercise_id, set: s.set_index, kg: s.weight_kg, reps: s.reps,
            })),
          })),
        });
      }
      case 'get_previous_plans': {
        const [{ data: planes }, { data: rutinas }] = await Promise.all([
          sb.from('plan').select('name, start_date, end_date, notes, blocks, goals, weekly_schedule')
            .eq('status', 'archived').order('id', { ascending: false }).limit(5),
          sb.from('routines').select('id, name, tag, muscle_groups').eq('archived', true),
        ]);
        if (!planes?.length && !rutinas?.length) {
          return JSON.stringify({ nota: 'No hay nada anterior: es su primer plan.' });
        }
        return JSON.stringify({ planes_anteriores: planes ?? [], entrenos_archivados: rutinas ?? [] });
      }
      case 'set_profile': {
        const campos = ['display_name', 'sex', 'birth_date', 'height_cm', 'weight_kg',
          'goals', 'experience', 'equipment', 'training_days'];
        const patch: any = {};
        for (const c of campos) if (input[c] !== undefined && input[c] !== null) patch[c] = input[c];
        if (!Object.keys(patch).length) return JSON.stringify({ error: 'nada que guardar' });
        // Compatibilidad: el año suelto y el objetivo único siguen existiendo
        if (patch.birth_date) patch.birth_year = Number(String(patch.birth_date).slice(0, 4)) || null;
        if (Array.isArray(patch.goals)) patch.goal = patch.goals[0] ?? null;
        patch.updated_at = new Date().toISOString();
        const { data, error } = await sb.from('profiles').update(patch)
          .eq('user_id', userId).select().maybeSingle();
        if (error) throw error;
        return JSON.stringify({ ok: true, perfil: data });
      }
      case 'get_macros': {
        const { data: p } = await sb.from('plan')
          .select('goals').eq('status', 'active').limit(1).maybeSingle();
        const n = (p?.goals ?? {}).nutrition ?? {};
        if (n.training || n.rest) return JSON.stringify({ formato: 'por_tipo_de_dia', ...n });
        return JSON.stringify({ formato: 'unico', unico: n });
      }
      case 'set_macros': {
        const { data: p, error: eGet } = await sb.from('plan')
          .select('id, goals').eq('status', 'active').limit(1).maybeSingle();
        if (eGet) throw eGet;
        if (!p) return JSON.stringify({ error: 'no hay plan activo' });

        const goals: any = { ...(p.goals ?? {}) };
        const previo = goals.nutrition ?? {};
        const base = (previo.training || previo.rest)
          ? { training: previo.training ?? {}, rest: previo.rest ?? {} }
          : { training: { ...previo }, rest: { ...previo } };

        if (input.training) base.training = { ...base.training, ...input.training };
        if (input.rest) base.rest = { ...base.rest, ...input.rest };
        base.training.kcal = kcalDe(base.training);
        base.rest.kcal = kcalDe(base.rest);
        goals.nutrition = base;

        const { error } = await sb.from('plan').update({ goals }).eq('id', p.id);
        if (error) throw error;
        return JSON.stringify({ ok: true, nutrition: base });
      }
      case 'get_meals': {
        let desde = input.date ?? input.from ?? hoyIso;
        let hasta = input.date ?? input.to ?? desde;
        if (!esFecha(desde) || !esFecha(hasta)) {
          return JSON.stringify({ error: 'Las fechas van en formato YYYY-MM-DD.' });
        }
        if (hasta < desde) { const x = desde; desde = hasta; hasta = x; }
        const dias: string[] = [];
        for (let d = desde; d <= hasta && dias.length <= 31; d = masDias(d, 1)) dias.push(d);
        if (dias.length > 31) {
          return JSON.stringify({ error: 'Rango demasiado largo: pide como mucho 31 días de una vez.' });
        }

        const [{ data: comidas, error }, p, esEntreno] = await Promise.all([
          sb.from('meals').select('*').gte('date', desde).lte('date', hasta).order('date').order('created_at'),
          planActivo(sb),
          diasDeEntreno(sb, desde, hasta, hoyIso),
        ]);
        if (error) throw error;
        const juegos = macrosPorTipo(p?.goals);

        const porDia = dias.map((iso) => {
          const delDia = (comidas ?? []).filter((m: any) => m.date === iso);
          const entreno = esEntreno(iso);
          const objetivo: any = { ...(entreno ? juegos.entreno : juegos.descanso) };
          if (Object.keys(objetivo).length && !objetivo.kcal) objetivo.kcal = kcalDe(objetivo);
          const totales = totalesDe(delDia);
          return {
            dia: iso,
            tipo_de_dia: entreno ? 'entreno' : 'descanso',
            comidas: delDia.map((m: any) => ({
              bloque: BLOQUES[m.meal_type] ?? m.meal_type,
              descripcion: m.description,
              protein_g: Number(m.protein_g) || 0,
              carbs_g: Number(m.carbs_g) || 0,
              fat_g: Number(m.fat_g) || 0,
              fiber_g: Number(m.fiber_g) || 0,
              kcal: Number(m.kcal) || 0,
            })),
            totales,
            objetivo: Object.keys(objetivo).length ? objetivo : null,
            falta: Object.keys(objetivo).length ? faltaPara(objetivo, totales) : null,
          };
        });

        // Media SOLO de los días con algo apuntado: los días vacíos son días
        // que no apuntó, no días que no comió, y hundirían la media.
        const conDatos = porDia.filter((d) => d.comidas.length);
        const media = (k: string) => (conDatos.length
          ? Math.round((conDatos.reduce((a, d: any) => a + (d.totales[k] || 0), 0) / conDatos.length) * 10) / 10
          : 0);
        return JSON.stringify({
          desde, hasta,
          objetivos_por_tipo_de_dia: juegos.dual,
          dias_apuntados: conDatos.length,
          dias_sin_apuntar: porDia.length - conDatos.length,
          media_de_los_dias_apuntados: conDatos.length
            ? { protein_g: media('protein_g'), carbs_g: media('carbs_g'), fat_g: media('fat_g'), fiber_g: media('fiber_g'), kcal: media('kcal') }
            : null,
          dias: porDia,
        });
      }
      case 'log_meal': {
        const fecha = input.date ?? hoyIso;
        if (!esFecha(fecha)) return JSON.stringify({ error: 'La fecha va en formato YYYY-MM-DD.' });
        if (fecha > hoyIso) {
          return JSON.stringify({ error: 'No se puede apuntar comida en el futuro. Usa hoy o un día pasado.' });
        }
        const descripcion = String(input.description ?? '').trim().slice(0, 120);
        if (!descripcion) return JSON.stringify({ error: 'Falta la descripción de la comida.' });
        const bloque = BLOQUES[input.meal_type] ? input.meal_type : 'other';
        const num = (v: any) => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);
        const fila = {
          date: fecha,
          description: descripcion,
          meal_type: bloque,
          protein_g: num(input.protein_g),
          carbs_g: num(input.carbs_g),
          fat_g: num(input.fat_g),
          fiber_g: num(input.fiber_g),
          kcal: num(input.kcal) || kcalDe({
            protein_g: num(input.protein_g), carbs_g: num(input.carbs_g), fat_g: num(input.fat_g),
          }),
          source: 'coach',
        };
        const { data, error } = await sb.from('meals').insert(fila).select().maybeSingle();
        if (error) throw error;
        // Cómo queda el día tras apuntarla, para que se lo pueda contar
        const resumen = await resumenDelDia(sb, fecha, hoyIso);
        return JSON.stringify({ ok: true, apuntada: data, dia: resumen });
      }
      case 'finish_first_session': {
        if (!input.force) {
          const [{ data: rs }, p] = await Promise.all([
            sb.from('routines').select('id').eq('archived', false),
            planActivo(sb),
          ]);
          const entrenos = (rs ?? []).filter((r: any) => r.id !== 'rest').length;
          const sched = p?.weekly_schedule ?? {};
          const diasConEntreno = Object.values(sched).filter((v: any) => v && v !== 'rest').length;
          const falta: string[] = [];
          if (!entrenos) falta.push('no has creado ningún entreno (upsert_routine)');
          if (!diasConEntreno) falta.push('el calendario está vacío (set_weekly_schedule)');
          if (!(p?.goals ?? {}).shortTerm) falta.push('no has escrito los objetivos (set_goals)');
          const m = macrosPorTipo(p?.goals);
          if (!m.entreno.protein_g && !m.descanso.protein_g) falta.push('no has guardado los macros (set_macros)');
          if (falta.length) {
            return JSON.stringify({ error: 'Aún no puedes cerrar la primera sesión: ' + falta.join('; ') });
          }
        }
        const { error } = await sb.from('profiles')
          .update({ first_session_done: true, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (error) throw error;
        return JSON.stringify({ ok: true });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: String((e as Error).message ?? e) });
  }
}

// ---------- Perfil del usuario (spec del Coach §2) ----------
const OBJETIVOS: Record<string, string> = {
  'perder-grasa': 'perder grasa',
  'ganar-musculo': 'ganar músculo',
  'recomposicion': 'recomposición (bajar grasa manteniendo masa magra)',
  'salud-forma': 'salud y forma física',
  'mejorar-entrenos': 'mejorar sus entrenamientos',
  'competicion': 'prepararse para competir',
  'mantenerme': 'mantenerse y estar sano',
};
const SITIOS: Record<string, string> = {
  gimnasio: 'gimnasio', casa: 'casa', exterior: 'exterior',
  deporte: 'un deporte concreto (PREGÚNTALE cuál)',
};
const TONO_NIVEL: Record<string, string> = {
  novato: 'Es NOVATO: ten paciencia, explica el porqué de cada decisión y no des nada por supuesto. Celebra lo básico sin exagerar.',
  intermedio: 'Tiene experiencia INTERMEDIA: ve al grano, da el dato y la decisión, sin explicar lo obvio.',
  avanzado: 'Es AVANZADO: al grano y con nivel técnico. No expliques lo básico.',
};

function edadDe(p: any): number | null {
  if (p?.birth_date) {
    const n = new Date(p.birth_date);
    if (!isNaN(n.getTime())) {
      const hoy = new Date();
      let a = hoy.getFullYear() - n.getFullYear();
      const m = hoy.getMonth() - n.getMonth();
      if (m < 0 || (m === 0 && hoy.getDate() < n.getDate())) a--;
      return a;
    }
  }
  if (p?.birth_year) return new Date().getFullYear() - p.birth_year;
  return null;
}

function textoPerfil(p: any): string {
  if (!p) return 'AÚN NO SABES NADA DE ESTE USUARIO: no tiene ficha creada.';
  const trozos: string[] = [];
  if (p.display_name) trozos.push(`Se llama ${p.display_name}`);
  if (p.sex) trozos.push(p.sex === 'mujer' ? 'mujer' : 'hombre');
  const edad = edadDe(p);
  if (edad) trozos.push(`${edad} años`);
  if (p.height_cm) trozos.push(`${p.height_cm} cm`);
  if (p.weight_kg) trozos.push(`${p.weight_kg} kg`);
  const objetivos = Array.isArray(p.goals) && p.goals.length ? p.goals : (p.goal ? [p.goal] : []);
  if (objetivos.length) {
    trozos.push(`busca: ${objetivos.map((g: string) => OBJETIVOS[g] ?? g).join(', ')}`);
  }
  if (p.experience) trozos.push(`nivel: ${p.experience}`);
  if (Array.isArray(p.equipment) && p.equipment.length) {
    trozos.push(`entrena en: ${p.equipment.map((e: string) => SITIOS[e] ?? e).join(', ')}`);
  }
  if (p.training_days) trozos.push(`${p.training_days} días por semana`);
  if (!trozos.length) return 'Tiene ficha creada pero VACÍA: no sabes nada de él todavía.';

  const faltan: string[] = [];
  if (!p.display_name) faltan.push('nombre');
  if (!p.sex) faltan.push('sexo');
  if (!edad) faltan.push('edad');
  if (!p.height_cm) faltan.push('altura');
  if (!p.weight_kg) faltan.push('peso');
  if (!objetivos.length) faltan.push('qué busca');
  if (!p.experience) faltan.push('nivel de experiencia');
  if (!Array.isArray(p.equipment) || !p.equipment.length) faltan.push('dónde entrena');
  if (!p.training_days) faltan.push('días por semana');

  let txt = trozos.join(' · ') + '.';
  if (faltan.length) {
    txt += `\nTE FALTA SABER: ${faltan.join(', ')}. Pregúntaselo cuando venga a cuento y guárdalo con set_profile.`;
  }
  return txt;
}

const TOOL_STATUS: Record<string, string> = {
  get_week: 'Mirando tu semana…',
  set_day: 'Cambiando el día…',
  set_weekly_schedule: 'Montando tu semana…',
  get_routine: 'Abriendo el entreno…',
  list_routines: 'Repasando tus entrenos…',
  upsert_routine: 'Guardando el entreno…',
  list_exercises: 'Repasando el catálogo…',
  add_exercise: 'Añadiendo el ejercicio…',
  get_history: 'Mirando tu historial…',
  get_previous_plans: 'Mirando tus planes anteriores…',
  get_macros: 'Mirando tus macros…',
  set_macros: 'Guardando tus macros…',
  get_meals: 'Mirando lo que has comido…',
  log_meal: 'Apuntando la comida…',
  set_goals: 'Escribiendo tus objetivos…',
  set_plan: 'Montando tu programa…',
  set_profile: 'Apuntando tus datos…',
  finish_first_session: 'Dejándolo todo listo…',
};

const ACTION_LABELS: Record<string, (i: any) => string> = {
  set_day: (i) => `📅 Día modificado (${i.week_start} · día ${i.day_of_week} → ${i.routine_id})`,
  set_weekly_schedule: () => `📅 Calendario semanal montado`,
  upsert_routine: (i) => `💪 Entreno guardado: ${i.name}`,
  add_exercise: (i) => `➕ Ejercicio añadido: ${i.name}`,
  set_macros: (i) => `🥗 Macros actualizados${i.training && i.rest ? ' (entreno y descanso)' : i.training ? ' (días de entreno)' : ' (días de descanso)'}`,
  log_meal: (i) => `🍽️ Comida apuntada: ${i.description}`,
  set_goals: () => `🎯 Objetivos guardados`,
  set_plan: (i) => `🗺️ Programa creado: ${i.name}`,
  set_profile: () => `👤 Ficha actualizada`,
  finish_first_session: () => `✅ Tu plan está listo`,
};

// ---------- Dónde está: bloque, sesión de hoy y últimos 14 días ----------
// Texto compacto para el bloque VARIABLE del prompt (objetivo < 1.500 tokens):
// notas y esquemas recortados, como mucho 12 ejercicios y 14 entrenos.
const corta = (t: any, n: number) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};
const ritmo = (seg: number, m: number) => {
  if (!seg || !m) return null;
  const sk = seg / (m / 1000);
  const mm = Math.floor(sk / 60), ss = Math.round(sk % 60);
  return ss === 60 ? `${mm + 1}:00/km` : `${mm}:${String(ss).padStart(2, '0')}/km`;
};

async function textoSituacion(sb: any, plan: any, est: any, hoy: string): Promise<string> {
  const lineas: string[] = [];
  lineas.push('DÓNDE ESTÁ EN SU PLAN (calculado por la fecha de hoy; manda sobre cualquier otro dato):');
  if (!est) {
    lineas.push('- No tiene plan por bloques todavía.');
  } else if (est.caducado) {
    lineas.push(`- SU PLAN TERMINÓ EL ${fechaCorta(est.fin)} (${est.fin}). Hoy no cae en ningún bloque. Díselo con naturalidad al principio y proponle montar el siguiente (set_goals + set_plan, y los entrenos que hagan falta). No hables como si siguiera en un bloque.`);
  } else if (est.antes) {
    lineas.push(`- El plan empieza el ${fechaCorta(est.ini)}; aún no ha arrancado.`);
  } else {
    const b = est.bloque;
    lineas.push(`- Semana ${est.semana} de ${est.semanas} del plan (${fechaCorta(est.ini)} → ${fechaCorta(est.fin)}).${b ? ` Bloque actual: "${b.name}" (${fechaCorta(b.startDate)} → ${fechaCorta(b.endDate)}, bloque ${est.idx + 1} de ${est.blocks.length}).` : ''}`);
  }
  if (est) {
    lineas.push('- Bloques: ' + est.blocks.map((b: any, i: number) =>
      `${i + 1}) ${corta(b.name, 40)} ${b.startDate}→${b.endDate}${b.scheme ? `: ${corta(b.scheme, 90)}` : ''}`).join(' | '));
  }
  if (est?.deadline) {
    lineas.push(est.faltan != null
      ? `- Faltan ${est.faltan} días hasta la fecha límite de corto plazo (${est.deadline}).`
      : `- La fecha límite de corto plazo (${est.deadline}) ya pasó.`);
  }

  // Sesión de HOY: apaño de la semana o calendario base
  const dow = diaSemana(hoy);
  const [{ data: ovr }, { data: ws }] = await Promise.all([
    sb.from('week_overrides').select('routine_id').eq('week_start', lunesDe(hoy)).eq('day_of_week', dow).maybeSingle(),
    sb.from('workouts').select('id, date, routine_id, duration_sec').gte('date', masDias(hoy, -14)).lte('date', hoy).order('date'),
  ]);
  const ridHoy = ovr ? (ovr.routine_id ?? 'rest') : (plan?.weekly_schedule?.[String(dow)] ?? 'rest');
  const ids = (ws ?? []).map((w: any) => w.id);
  const [{ data: rex }, { data: sets }] = await Promise.all([
    ridHoy && ridHoy !== 'rest'
      ? sb.from('routine_exercises').select('exercise_id, sets, reps_target, notes').eq('routine_id', ridHoy).order('position')
      : Promise.resolve({ data: [] }),
    ids.length
      ? sb.from('workout_sets').select('workout_id, exercise_id, weight_kg, reps, seconds, distance_m, avg_hr').in('workout_id', ids)
      : Promise.resolve({ data: [] }),
  ]);
  const exIds = [...new Set([...(rex ?? []), ...(sets ?? [])].map((x: any) => x.exercise_id).filter(Boolean))];
  const { data: cat } = exIds.length
    ? await sb.from('exercises').select('id, name, log_type').in('id', exIds)
    : { data: [] };
  const ex: Record<string, any> = {};
  (cat ?? []).forEach((e: any) => { ex[e.id] = e; });

  if (!ridHoy || ridHoy === 'rest') {
    lineas.push(`SESIÓN DE HOY (${DIAS[dow]}): descanso.`);
  } else {
    const lista = (rex ?? []).slice(0, 12).map((r: any) =>
      `${ex[r.exercise_id]?.name ?? r.exercise_id} ${r.sets ?? '?'}×${r.reps_target ?? '?'}${r.notes ? ` (${corta(r.notes, 100)})` : ''}`);
    const mas = (rex ?? []).length > 12 ? ` …y ${(rex ?? []).length - 12} más` : '';
    lineas.push(`SESIÓN DE HOY (${DIAS[dow]}): ${ridHoy}${lista.length ? ' — ' + lista.join('; ') + mas : ' (sin ejercicios)'}.`);
  }

  // Últimos 14 días: cardio con km, min y ritmo; fuerza con la mejor serie
  if (!(ws ?? []).length) {
    lineas.push('ÚLTIMOS 14 DÍAS: ningún entreno registrado.');
  } else {
    const porW: Record<string, any[]> = {};
    (sets ?? []).forEach((st: any) => { (porW[st.workout_id] ||= []).push(st); });
    const filas = (ws ?? []).slice(-14).map((w: any) => {
      const porEx: Record<string, any[]> = {};
      (porW[w.id] ?? []).forEach((st: any) => { (porEx[st.exercise_id] ||= []).push(st); });
      const trozos = Object.entries(porEx).map(([id, ss]) => {
        const nombre = ex[id]?.name ?? id;
        if (ex[id]?.log_type === 'cardio' || ss.some((x) => x.distance_m)) {
          const m = ss.reduce((a, x) => a + (Number(x.distance_m) || 0), 0);
          const seg = ss.reduce((a, x) => a + (Number(x.seconds) || 0), 0);
          return [nombre, m ? `${(m / 1000).toFixed(1)} km` : null, seg ? `${Math.round(seg / 60)} min` : null, ritmo(seg, m)]
            .filter(Boolean).join(' ');
        }
        if (ss.every((x) => x.weight_kg == null && x.reps == null)) {
          const seg = Math.max(...ss.map((x) => Number(x.seconds) || 0));
          return seg ? `${nombre} ${seg}s` : nombre;
        }
        const mejor = ss.reduce((a, b) => ((Number(b.weight_kg) || 0) > (Number(a.weight_kg) || 0)
          || ((Number(b.weight_kg) || 0) === (Number(a.weight_kg) || 0) && (b.reps || 0) > (a.reps || 0)) ? b : a));
        return `${nombre} ${mejor.weight_kg ?? '—'}×${mejor.reps ?? '—'}`;
      });
      return `${w.date} ${w.routine_id ?? 'libre'}${trozos.length ? ': ' + trozos.join(', ') : ''}`;
    });
    lineas.push('ÚLTIMOS 14 DÍAS: ' + filas.map((f) => corta(f, 220)).join(' | '));
  }
  return lineas.join('\n');
}

// ---------- Prompt del sistema ----------
// Va PARTIDO EN DOS para que el caché funcione: este primer bloque es idéntico
// para todos los usuarios y todas las peticiones, así que se cachea una vez y
// se reaprovecha siempre. Lo que cambia (fecha, ficha, plan) va en el segundo.
// Si tocas algo de aquí, la primera llamada de cada usuario paga caché nuevo.
const SYSTEM_BASE = `Eres el Coach: el entrenador personal del usuario dentro de su app de fitness (ONIX). Respondes SIEMPRE en español, breve y directo, como un buen entrenador: claro, motivador sin ñoñerías, y técnico cuando hace falta.

El calendario semanal usa 0=domingo..6=sábado y las semanas se identifican por su LUNES (week_start). La zona horaria es Europe/Madrid.

QUÉ PUEDES TOCAR Y DÓNDE SE VE:
- upsert_routine → sus entrenos, en la pestaña Trainer.
- set_weekly_schedule → qué toca cada día, en la pantalla de inicio. Es el calendario de todas las semanas.
- set_day → un apaño de UNA semana concreta (viaje, imprevisto). No confundir con el anterior.
- set_goals → la pestaña Objetivos.
- set_plan → la pestaña Programa (las fases del plan).
- set_macros → los objetivos de macros de la pantalla de Nutrición.
- get_meals y log_meal → el diario de comidas de la pantalla de Nutrición.
- set_profile → su ficha.

REGLAS:
- Para cualquier cambio usa las herramientas; no describas cambios sin ejecutarlos. Aparecen en su móvil en tiempo real.
- Antes de modificar una semana concreta, consulta su estado con get_week. Antes de crear entrenos, comprueba el catálogo con list_exercises y lo que ya tiene con list_routines.
- Si te dice que una semana está limitada (viaje, material, tiempo), adapta con criterio: mantén el estímulo semanal, prioriza básicos y ajusta volumen.
- Para preguntas de progreso usa get_history y responde con sus datos reales.
- LO PEDIDO SE APLICA, LO NO PEDIDO SE PROPONE. Si te lo pide, hazlo y avisa de lo que has tocado. Si es idea tuya, propónlo, explica el porqué y ESPERA su confirmación antes de escribir nada.
- Si averiguas datos suyos conversando (peso, nivel, días, material), guárdalos con set_profile.
- Nada de tablas ni markdown: la app las pinta en crudo y se ven mal. Texto plano y listas cortas con guiones.
- DÓNDE ESTÁ: el contexto te dice en qué semana y bloque está HOY, calculado por fecha. Fíate de eso y no de lo que diga una conversación anterior. Si su plan ha terminado, díselo y propón el siguiente.

NO TE INVENTES NI TE CONTRADIGAS:
- Eventos reales (carreras, pruebas, marchas): antes de guardar en el plan o en los objetivos su distancia, desnivel, fecha u hora, confírmalos con web_search (como mucho dos búsquedas) en una fuente fiable, a ser posible la web oficial. Úsala SOLO para eso. Si no lo puedes confirmar, pregúntaselo a él y no pongas cifras: una cifra inventada acaba en su plan como si fuera verdad.
- Una sola fuente de verdad: la progresión semana a semana (km, cargas, series por semana) vive en los bloques del plan (set_plan). Las notas de un entreno describen CÓMO hacer la sesión (técnica, ritmo, sensaciones), nunca otra progresión por semanas con otras cifras. Si cambias la progresión, cámbiala en set_plan.
- Si una herramienta te devuelve un error de validación, corrige lo que dice y vuelve a llamarla; no le cuentes el cambio como hecho hasta que salga bien.

NUTRICIÓN — OBJETIVOS DE MACROS:
- Puede haber DOS juegos, uno para días de entreno y otro para días de descanso, y la app enseña el que toca según si ese día hay entrenamiento. Antes de tocarlos usa get_macros; para cambiarlos, set_macros (puedes enviar solo uno de los dos). Si te da unos números sin decir para qué días son, pregúntale si van para los dos juegos o solo para uno: no lo supongas.

NUTRICIÓN — LO QUE COME:
- get_meals te dice lo que ha comido, un día o un rango, con los totales de cada día y el objetivo que le tocaba ESE día. Úsalo SIEMPRE antes de opinar sobre su dieta, decirle lo que le falta o proponerle una cena. Nunca te inventes lo que ha comido ni des por hecho que ha cumplido.
- Cuando te cuente lo que ha comido y quiera apuntarlo, usa log_meal: una llamada por plato o alimento. Los macros los estimas TÚ, con raciones realistas; si no dice cantidad, estima una normal para él y déjala escrita entre paréntesis en la descripción.
- Bloques de comida: breakfast (desayuno), lunch (comida), dinner (cena), other (snacks, batidos, picoteo).
- Si no te queda claro qué comió o cuánto, pregúntaselo antes de apuntarlo: es su diario, no un borrador.
- Después de apuntar, dile en UNA línea cómo le queda el día (la propia herramienta te devuelve totales y lo que falta). No le sueltes la tabla entera de macros.
- Él también apunta comidas desde la pantalla de Nutrición, con foto o dictado: puede que ya esté puesto lo que te está contando. Si sospechas que sí, mira antes con get_meals.`;

// El guion de la primera sesión es texto fijo, pero solo se manda cuando toca:
// va al final del bloque variable para no romper el caché del bloque base.
const GUION_PRIMERA = `

=== ESTA ES LA PRIMERA SESIÓN. ES LA CONVERSACIÓN MÁS IMPORTANTE DE LA APP. ===
Su app está VACÍA: no tiene entrenos, ni calendario, ni objetivos, ni macros. Todo eso sale de esta charla. Hasta que la termines, no puede usar el chat para otra cosa.

CÓMO LLEVARLA:
1. Ya te has presentado en el primer mensaje. No vuelvas a presentarte.
2. Pregunta de UNA en UNA, como mucho dos cosas juntas. Nada de cuestionarios en ráfaga ni listas numeradas de preguntas. Es una conversación, no un formulario. Reacciona a lo que te cuente antes de seguir.
3. Lo que necesitas sacar, en este orden aproximado y saltándote lo que ya sepas por su ficha:
   - Qué quiere conseguir y por qué ahora. Si hay una fecha o un reto concreto (una carrera, una boda, el verano, una competición), apúntalo.
   - Cómo le gusta entrenar y dónde. Si en su ficha pone "un deporte concreto", pregúntale CUÁL y cuántos días le dedica.
   - De dónde parte: qué está haciendo ahora, cuánto tiempo lleva parado si lo está, lesiones o molestias.
   - Cuántos días de verdad puede entrenar, qué días de la semana le vienen bien y cuánto tiempo tiene por sesión.
   - Nutrición, en UNA pregunta natural y sin sermón: qué busca con la comida (perder grasa, ganar músculo, mantenerse, simplemente comer mejor…) y cómo come ahora a grandes rasgos (cuántas comidas al día, si cocina o come fuera, si hay algo que no come o no le sienta bien). Si su objetivo de entreno ya lo deja claro, confírmalo en vez de preguntarlo de cero.
4. En cuanto tengas lo suficiente (no busques la información perfecta: cinco o seis intercambios bastan), PROPÓN el plan en pocas líneas: cuántos días, qué entreno cada día, en qué fases y qué objetivos. En el mismo mensaje propón unos macros iniciales: si entrena unos días y descansa otros, un juego para días de entreno y otro para descanso (proteína, carbohidratos, grasa y kcal de cada uno); explícalos en una o dos frases (por qué esa proteína, por qué más carbohidrato los días de entreno). Y déjale claro, con tono cercano y sin dramatismo, que no tiene que obsesionarse: son una referencia para equilibrar lo que come, no una norma que haya que clavar cada día; si un día se pasa o no llega, no pasa nada. Pídele su visto bueno a todo junto.
5. Con su OK, escribe TODO de una tacada y sin volver a pedir permiso, en este orden:
   a) upsert_routine, uno por cada entreno del plan (usa list_exercises antes; add_exercise solo si falta algo).
   b) set_weekly_schedule con los siete días.
   c) set_goals con objetivos de corto y de largo plazo.
   d) set_plan con las fases.
   e) set_macros con los macros que le has propuesto (los dos juegos, entreno y descanso, salvo que no tenga días de descanso), calculados con su sexo, edad, altura, peso y objetivo de nutrición. Si no quiso macros, pon igualmente unos de referencia suaves y díselo.
   f) finish_first_session.
6. Cierra contándole en cuatro líneas qué le has dejado montado y dónde lo ve en la app: los entrenos en Trainer, el programa y los objetivos en sus pestañas, la semana en el inicio y los macros en Nutrición.

REGLAS DE ESTA SESIÓN:
- No la alargues: apunta a unos cinco minutos de conversación.
- NO termines sin llamar a finish_first_session. Si el usuario se enrolla, reconduce con suavidad.
- Con la comida, tono de colega, no de nutricionista: nada de listas de alimentos prohibidos, ni de pesar cada gramo, ni de culpa. Los macros orientan; lo importante es la tendencia de la semana.
- Si dice que ahora no quiere plan o que se lo piensa, no insistas más de una vez: llama a finish_first_session con force=true para no dejarle el chat bloqueado, y dile que cuando quiera se lo montas.
- Si es un plan REHECHO (ya había uno antes), empieza por get_previous_plans para saber de dónde viene y qué no le funcionó.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    if (!ANTHROPIC_KEY) return json({ error: 'Falta el secret ANTHROPIC_API_KEY en Supabase' }, 500);

    const authHeader = req.headers.get('Authorization') ?? '';
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: 'No autenticado' }, 401);

    const { messages: clientMessages } = await req.json();
    if (!Array.isArray(clientMessages) || !clientMessages.length) {
      return json({ error: 'messages vacío' }, 400);
    }

    // Topes ANTES de llamar a la API. Van como eventos NDJSON: `limit` para la
    // app (saca la ventana del tope) y detrás un `error` con el texto, que es
    // lo único que entienden las versiones viejas; las nuevas lo ignoran.
    const tope = await checkLimits(user.id, 'coach');
    if (tope) {
      const lineas = JSON.stringify({ t: 'limit', reason: tope.reason, feature: tope.feature }) + '\n'
        + JSON.stringify({ t: 'error', v: tope.msg }) + '\n';
      return new Response(lineas, {
        headers: { ...CORS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }

    const [{ data: plan }, { data: perfil }, { data: rutinas }] = await Promise.all([
      sb.from('plan')
        .select('id, name, notes, goals, current_block, weekly_schedule, start_date, end_date, blocks')
        .eq('status', 'active').limit(1).maybeSingle(),
      sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
      sb.from('routines').select('id, name, tag').eq('archived', false),
    ]);
    const now = new Date();
    const madrid = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }).format(now);
    const hoyIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
    const primeraSesion = !perfil?.first_session_done;

    // Bloque actual por fecha (y se re-guarda si current_block se quedó atrás)
    const est = plan ? estadoPlan(plan, hoyIso) : null;
    if (plan && est) await sincronizaBloque(sb, plan.id, plan.current_block, est);
    const situacion = await textoSituacion(sb, plan, est, hoyIso);
    // Lo que va en PLAN VIGENTE: sin bloques ni current_block (van arriba, ya
    // resueltos por fecha: dos versiones del mismo dato solo confunden).
    const planCorto = plan
      ? { name: plan.name, notes: plan.notes, start_date: plan.start_date, end_date: plan.end_date, goals: plan.goals, weekly_schedule: plan.weekly_schedule }
      : {};

    // Bloque VARIABLE del prompt: todo lo que cambia de un usuario a otro y de
    // un día a otro. Va detrás del bloque fijo para no invalidar su caché.
    const contexto = `Hoy es ${madrid} (${hoyIso}).

QUIÉN ES QUIEN TE HABLA:
${textoPerfil(perfil)}
${perfil?.experience ? (TONO_NIVEL[perfil.experience] ?? '') : 'No sabes su nivel todavía: no des por hecho que es principiante ni que es experto.'}
Llámale por su nombre cuando encaje, sin repetirlo en cada frase. NO te inventes datos suyos que no estén aquí: si no lo sabes, pregúntalo.

${situacion}

PLAN VIGENTE: ${JSON.stringify(planCorto)}
SUS ENTRENOS AHORA MISMO: ${JSON.stringify(rutinas ?? [])}${primeraSesion ? GUION_PRIMERA : ''}`;

    // Dos puntos de caché: el bloque fijo (compartido por todo el mundo) y el
    // prompt completo (que se reaprovecha en cada ronda del bucle de esta
    // misma conversación). Con las herramientas son tres, del máximo de cuatro.
    const system = [
      { type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contexto, cache_control: { type: 'ephemeral' } },
    ];

    // ---------- Respuesta EN DIRECTO ----------
    // NDJSON: una línea JSON por evento.
    //   {"t":"text","v":"…"}    trozo de texto del entrenador
    //   {"t":"tool","v":"…"}    qué está haciendo ("" = ya no hace nada)
    //   {"t":"action","v":"…"}  chip de cambio aplicado
    //   {"t":"done"} | {"t":"error","v":"…"}
    const messages: any[] = clientMessages.slice(-24);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        try {
          for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: MODEL, max_tokens: MAX_TOKENS,
                system, tools: TOOLS_CACHEADAS, messages, stream: true,
              }),
            });
            if (!resp.ok || !resp.body) {
              const errTxt = await resp.text().catch(() => '');
              send({ t: 'error', v: `Anthropic ${resp.status}: ${errTxt.slice(0, 300)}` });
              return;
            }

            // Los bloques llegan por trozos y hay que recomponerlos: el texto para
            // el historial, el JSON de cada herramienta para ejecutarla, y los
            // bloques de razonamiento TAL CUAL (con su firma), porque hay que
            // devolvérselos al modelo sin tocar en la siguiente ronda.
            const bloques: any[] = [];
            let stopReason = '';
            // Usage de la ronda: message_start trae la entrada (y la caché) y
            // message_delta el total de salida.
            let usage: any = {};
            let buf = '';
            const reader = resp.body.getReader();
            const dec = new TextDecoder();
            let fin = false;
            while (!fin) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const lineas = buf.split('\n');
              buf = lineas.pop() ?? '';
              for (const linea of lineas) {
                if (!linea.startsWith('data:')) continue;
                const carga = linea.slice(5).trim();
                if (!carga || carga === '[DONE]') continue;
                let ev: any;
                try { ev = JSON.parse(carga); } catch { continue; }

                if (ev.type === 'message_start') {
                  usage = { ...(ev.message?.usage ?? {}) };
                } else if (ev.type === 'content_block_start') {
                  const cb = ev.content_block ?? {};
                  if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
                    bloques[ev.index] = { ...cb, _json: '' };
                    if (cb.type === 'server_tool_use') send({ t: 'tool', v: 'Buscando en internet…' });
                  } else if (cb.type === 'web_search_tool_result') bloques[ev.index] = { ...cb };
                  else if (cb.type === 'thinking') {
                    bloques[ev.index] = { type: 'thinking', thinking: cb.thinking ?? '', signature: cb.signature ?? '' };
                  } else if (cb.type === 'redacted_thinking') bloques[ev.index] = { ...cb };
                  else bloques[ev.index] = { ...cb, text: '' };
                } else if (ev.type === 'content_block_delta') {
                  const b = bloques[ev.index];
                  if (!b) continue;
                  const d = ev.delta ?? {};
                  if (d.type === 'text_delta') {
                    b.text += d.text;
                    send({ t: 'text', v: d.text });
                  } else if (d.type === 'input_json_delta') {
                    b._json += d.partial_json ?? '';
                  } else if (d.type === 'thinking_delta') {
                    b.thinking = (b.thinking ?? '') + (d.thinking ?? '');
                  } else if (d.type === 'signature_delta') {
                    b.signature = d.signature ?? b.signature;
                  } else if (d.type === 'citations_delta' && d.citation) {
                    (b.citations ||= []).push(d.citation);
                  }
                } else if (ev.type === 'content_block_stop') {
                  const b = bloques[ev.index];
                  if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
                    try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
                    delete b._json;
                  }
                } else if (ev.type === 'message_delta') {
                  stopReason = ev.delta?.stop_reason ?? stopReason;
                  for (const [k, v] of Object.entries(ev.usage ?? {})) if (v != null) usage[k] = v;
                } else if (ev.type === 'message_stop') {
                  fin = true;
                }
              }
            }

            await logUsage(user.id, 'chat', round === 0 ? 'coach' : 'coach_round', usage);
            const busquedas = Number(usage?.server_tool_use?.web_search_requests) || 0;
            if (busquedas) await logSearches(user.id, busquedas);

            // Un bloque de texto vacío hace que la API rechace el mensaje al
            // reenviarlo. Y un bloque de razonamiento sin firma tampoco vale.
            const content = bloques.filter((b: any) => b
              && (b.type !== 'text' || (b.text ?? '').trim())
              && (b.type !== 'thinking' || b.signature));

            if (stopReason === 'refusal') {
              send({ t: 'error', v: 'Esa petición no la puedo atender. Prueba a planteármela de otra forma.' });
              return;
            }
            // La búsqueda web (server tool) puede pausar el turno: se reenvía tal
            // cual y el servidor sigue donde lo dejó, sin mensaje nuevo.
            if (stopReason === 'pause_turn') {
              messages.push({ role: 'assistant', content });
              continue;
            }
            if (stopReason !== 'tool_use') break;

            messages.push({ role: 'assistant', content });
            const results: any[] = [];
            for (const block of content) {
              if (block.type !== 'tool_use') continue;
              send({ t: 'tool', v: TOOL_STATUS[block.name] ?? 'Trabajando…' });
              const result = await runTool(sb, block.name, block.input, user.id, hoyIso);
              const label = ACTION_LABELS[block.name];
              if (label && !result.includes('"error"')) send({ t: 'action', v: label(block.input) });
              results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            }
            messages.push({ role: 'user', content: results });
            send({ t: 'tool', v: '' });
          }
          send({ t: 'done' });
        } catch (e) {
          send({ t: 'error', v: String((e as Error).message ?? e) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...CORS,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
