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
//   propio punto de caché. El cuarto punto es automático y sigue al último
//   mensaje: cada ronda del bucle de herramientas lee de caché todo lo anterior
//   (conversación y tool_result incluidos), no solo herramientas + prompt.
// - HERRAMIENTAS, PROMPT FIJO Y LECTURA DEL STREAM viven en ./coach.ts.
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
import { TOOLS_CACHEADAS, SYSTEM_BASE, GUION_PRIMERA, ronda } from './coach.ts';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// El Coach razona y escribe el plan entero: aquí mandan las neuronas. Se
// cambia con el secret CHAT_MODEL, que es SOLO del Coach: la nutrición tiene
// el suyo propio (NUTRITION_MODEL), más barato.
const MODEL = Deno.env.get('CHAT_MODEL') ?? 'claude-sonnet-5-5';
// Esfuerzo (output_config.effort). En Sonnet 5.x el defecto es `high` y piensa
// antes de casi cada respuesta; en la prueba de humo `medium` resolvió igual
// los tres casos con ~20-35 % menos salida. Otros modelos: lo de la API.
const EFFORT = Deno.env.get('CHAT_EFFORT') ?? (MODEL.startsWith('claude-sonnet-5') ? 'medium' : undefined);
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

// ¿Rutina de cardio? Por etiqueta, nombre o id (una con todos sus ejercicios de
// cardio no puede llevar fuerza por definición: no hace falta mirarlo).
const RE_CARDIO = /carrera|correr|running|rodaje|bici|cardio|tirada|trote|nadar|nataci/i;

const BLOQUES: Record<string, string> = {
  breakfast: 'desayuno', lunch: 'comida', dinner: 'cena', other: 'otros',
};

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
  if (RE_CARDIO.test(`${input.tag ?? ''} ${input.name ?? ''} ${input.id ?? ''}`)) {
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
      case 'get_exercise_guide': {
        const ids = (Array.isArray(input.exercise_ids) ? input.exercise_ids : [input.exercise_ids])
          .map((x: any) => String(x ?? '')).filter(Boolean).slice(0, 10);
        if (!ids.length) return JSON.stringify({ error: 'Falta exercise_ids.' });
        const { data, error } = await sb.from('exercise_guides').select('exercise_id, guide').in('exercise_id', ids);
        if (error) throw error;
        const porId: Record<string, any> = {};
        (data ?? []).forEach((g: any) => { porId[g.exercise_id] = g.guide; });
        return JSON.stringify(ids.map((id: string) => porId[id]
          ? { exercise_id: id, ficha: porId[id] }
          : { exercise_id: id, ficha: null, nota: 'Este ejercicio no tiene ficha técnica.' }));
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
            // Cardio también: sin distancia ni tiempo, una carrera no se veía
            sets: sets.filter((s) => s.workout_id === w.id).map((s) => ({
              exercise_id: s.exercise_id, set: s.set_index, kg: s.weight_kg, reps: s.reps,
              ...(s.seconds != null ? { seconds: s.seconds } : {}),
              ...(s.distance_m != null ? { km: Math.round(Number(s.distance_m) / 10) / 100 } : {}),
              ...(s.avg_hr != null ? { ppm: s.avg_hr } : {}),
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
  get_exercise_guide: 'Mirando la técnica…',
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
    // misma conversación). Con las herramientas son tres; el cuarto (del máximo
    // de cuatro) es el automático que sigue a la conversación (ver coach.ts).
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
            const r = await ronda({
              key: ANTHROPIC_KEY, model: MODEL, maxTokens: MAX_TOKENS,
              system, tools: TOOLS_CACHEADAS, messages, effort: EFFORT,
            }, send);
            if (!r.ok) {
              send({ t: 'error', v: `Anthropic ${r.status}: ${r.error}` });
              return;
            }
            const { content, stopReason, usage } = r;

            await logUsage(user.id, 'chat', round === 0 ? 'coach' : 'coach_round', usage, MODEL);
            const busquedas = Number(usage?.server_tool_use?.web_search_requests) || 0;
            if (busquedas) await logSearches(user.id, busquedas, MODEL);

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
