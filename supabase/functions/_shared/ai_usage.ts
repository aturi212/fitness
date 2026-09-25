// ============================================================
// Control del uso de la IA: topes por usuario y registro del usage.
// Lo usan `chat` y `nutrition`. Escribe y cuenta con el SERVICE ROLE
// (la tabla ai_usage no deja insertar a los usuarios).
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

// ---------- Topes (cámbialos aquí) ----------
export const LIMITS = {
  perMinute: 10,       // peticiones de IA por usuario y minuto
  coachPerDay: 20,     // mensajes al Coach por usuario y día
  photoPerDay: 15,     // fotos de comida por usuario y día
  nutritionistPerDay: 10, // mensajes al nutricionista por usuario y día
  globalPerDay: 500,   // llamadas a la API por día entre TODOS (cortafuegos)
};
// Sin topes (Adrián). Sus llamadas se registran y cuentan en el global igual.
export const EXEMPT_USERS = new Set(['a032afc2-2aea-45ce-af23-1318af374ebd']);

export const LIMIT_MSG = 'Has llegado al límite de hoy, mañana seguimos 💪';
export const RATE_MSG = 'Vas muy rápido: espera un minuto y seguimos 💪';

export type Fn = 'chat' | 'nutrition';
export type Kind = 'coach' | 'coach_round' | 'photo' | 'text' | 'nutritionist';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

// null = puede seguir; string = mensaje amable para el usuario.
// Si falla el conteo no se bloquea a nadie: mejor gastar de más que romper la app.
export async function checkLimits(userId: string, kind: Kind): Promise<string | null> {
  if (EXEMPT_USERS.has(userId)) return null;
  const { data, error } = await admin.rpc('ai_usage_counts', { p_user: userId });
  if (error || !data) {
    console.error('ai_usage_counts', error?.message);
    return null;
  }
  const c = data as Record<string, number>;
  if (c.global >= LIMITS.globalPerDay) return LIMIT_MSG;
  if (c.minute >= LIMITS.perMinute) return RATE_MSG;
  if (kind === 'coach' && c.coach >= LIMITS.coachPerDay) return LIMIT_MSG;
  if (kind === 'photo' && c.photo >= LIMITS.photoPerDay) return LIMIT_MSG;
  if (kind === 'nutritionist' && c.nutritionist >= LIMITS.nutritionistPerDay) return LIMIT_MSG;
  return null;
}

// Guarda el usage que devuelve Anthropic. Nunca lanza: registrar no puede
// romper una respuesta.
export async function logUsage(userId: string, fn: Fn, kind: Kind, usage: any) {
  try {
    const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
    const { error } = await admin.from('ai_usage').insert({
      user_id: userId, fn, kind,
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
