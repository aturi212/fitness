// ============================================================
// Control del uso de la IA: topes por usuario y registro del usage.
// Lo usan `chat` y `nutrition`. Escribe y cuenta con el SERVICE ROLE
// (la tabla ai_usage no deja insertar a los usuarios).
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

// ---------- Topes (cámbialos aquí) ----------
export const LIMITS = {
  perMinute: 15,       // peticiones de IA por usuario y minuto
  coachPerDay: 40,     // mensajes al Coach por usuario y día
  nutritionistPerDay: 20, // mensajes al nutricionista por usuario y día
  globalPerDay: 500,   // llamadas a la API por día entre TODOS (cortafuegos)
};
// Comidas con IA al día según el plan: UN solo contador para foto y texto
// (y los reanálisis al editar, que van como 'text'). Premium no se anuncia
// como tope: es el cortafuegos técnico. Decisión de Adrián, 10-nov-2026
// (onix-hq/negocio/OXIA_tope_plan_gratis.md). La despensa, las etiquetas,
// lo apuntado a mano y las periódicas no llaman a la IA y no cuentan.
export const MEALS_PER_DAY: Record<string, number> = { free: 3, basic: 8, premium: 40 };
// Sin topes: Adrián y Julia (su hermana y la tester que más la usa; 14-nov-2026).
// Sus llamadas se registran y cuentan en el global igual.
export const EXEMPT_USERS = new Set([
  'a032afc2-2aea-45ce-af23-1318af374ebd',   // Adrián
  'ff00a48f-ec31-44d1-a0c4-d5879d7973e5',   // Julia
]);

// El texto solo lo ven las versiones viejas de la app (sin la ventana del
// tope): las nuevas pintan su modal a partir de `reason` y `feature`.
export const LIMIT_MSG = 'Has llegado al límite de hoy, mañana seguimos 💪';
export const RATE_MSG = 'Vas muy rápido: espera un minuto y seguimos 💪';

export type Fn = 'chat' | 'nutrition';
export type Kind = 'coach' | 'coach_round' | 'photo' | 'text' | 'nutritionist' | 'coach_search';
// day = tope del día (del usuario o el global); minute = demasiadas seguidas
export type Tope = { reason: 'day' | 'minute'; feature: Kind; msg: string; limit?: number; plan?: string };
// Cupo de comidas con IA de hoy (null = sin cupo: exento o no se pudo contar)
export type Cupo = { plan: string; limit: number; used: number; left: number };

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

// Medianoche de hoy en Madrid, en ISO (el día de los topes es el de Madrid)
function inicioDiaMadrid(): string {
  const ahora = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ahora).map((x) => [x.type, x.value]));
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const desfase = comoUtc - Math.floor(ahora.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - desfase).toISOString();
}

// Plan del usuario. Mientras no exista profiles.plan (migración
// 20261110_plan_usuario.sql), o venga vacío, todos son Gratis.
async function planDe(userId: string): Promise<string> {
  const { data, error } = await admin.from('profiles').select('plan').eq('user_id', userId).maybeSingle();
  if (error || !data) return 'free';
  return data.plan && MEALS_PER_DAY[data.plan] != null ? data.plan : 'free';
}

export async function mealQuota(userId: string): Promise<Cupo | null> {
  if (EXEMPT_USERS.has(userId)) return null;
  try {
    const [plan, cuenta] = await Promise.all([
      planDe(userId),
      admin.from('ai_usage').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).in('kind', ['photo', 'text']).gte('created_at', inicioDiaMadrid()),
    ]);
    if (cuenta.error) { console.error('mealQuota', cuenta.error.message); return null; }
    const limit = MEALS_PER_DAY[plan];
    const used = cuenta.count ?? 0;
    return { plan, limit, used, left: Math.max(0, limit - used) };
  } catch (e) {
    console.error('mealQuota', (e as Error).message);
    return null;
  }
}

// null = puede seguir; si no, el tope que ha saltado.
// Si falla el conteo no se bloquea a nadie: mejor gastar de más que romper la app.
export async function checkLimits(userId: string, kind: Kind): Promise<Tope | null> {
  if (EXEMPT_USERS.has(userId)) return null;
  const { data, error } = await admin.rpc('ai_usage_counts', { p_user: userId });
  if (error || !data) {
    console.error('ai_usage_counts', error?.message);
    return null;
  }
  const c = data as Record<string, number>;
  const dia: Tope = { reason: 'day', feature: kind, msg: LIMIT_MSG };
  if (c.global >= LIMITS.globalPerDay) return dia;
  if (c.minute >= LIMITS.perMinute) return { reason: 'minute', feature: kind, msg: RATE_MSG };
  if (kind === 'coach' && c.coach >= LIMITS.coachPerDay) return dia;
  if (kind === 'photo' || kind === 'text') {
    const q = await mealQuota(userId);
    if (q && q.used >= q.limit) return { ...dia, limit: q.limit, plan: q.plan };
  }
  if (kind === 'nutritionist' && c.nutritionist >= LIMITS.nutritionistPerDay) return dia;
  return null;
}

// Guarda el usage que devuelve Anthropic, con el modelo que lo gastó (para
// comparar costes por modelo). Nunca lanza: registrar no puede romper una
// respuesta.
export async function logUsage(userId: string, fn: Fn, kind: Kind, usage: any, model: string) {
  try {
    const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
    const { error } = await admin.from('ai_usage').insert({
      user_id: userId, fn, kind, model,
      input_tokens: n(usage?.input_tokens),
      output_tokens: n(usage?.output_tokens),
      cache_read_tokens: n(usage?.cache_read_input_tokens),
      cache_creation_tokens: n(usage?.cache_creation_input_tokens),
    });
    if (error) console.error('ai_usage insert', error.message);
  } catch (e) {
    console.error('ai_usage insert', (e as Error).message);
  }
}

// Búsquedas web del Coach (server tool web_search). Se cobran aparte de los
// tokens (10 $ por 1.000 búsquedas): una fila 'coach_search' por ronda con el
// número de búsquedas en web_searches. No cuenta para los topes.
export async function logSearches(userId: string, n: number, model: string) {
  try {
    const { error } = await admin.from('ai_usage').insert({
      user_id: userId, fn: 'chat', kind: 'coach_search', model, web_searches: Math.max(0, Math.round(n)),
    });
    if (error) console.error('ai_usage search insert', error.message);
  } catch (e) {
    console.error('ai_usage search insert', (e as Error).message);
  }
}
