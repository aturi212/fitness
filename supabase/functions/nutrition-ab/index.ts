// ============================================================
// Edge Function TEMPORAL "nutrition-ab": A/B de modelos para el registro de
// comida v3 (14-nov-2026). Mismo esquema y prompt que `nutrition`
// (../_shared/nutri_v3.ts); no escribe nada. Protegida por un token cuyo
// SHA-256 está aquí (el token no está en el repo). Se borra al terminar.
// ============================================================
import { MODELOS_AB, ajustesModelo, REGISTER_TOOL_V3, analyzeSystemV3, limpiaV3 } from '../_shared/nutri_v3.ts';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AB_HASH = '0f48c2d2e27d10f710cdeadbe6155f635f2a1fd1f74a57315b12de09fea8c52a';

async function sha256(t: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const body = await req.json();
    if (typeof body.token !== 'string' || (await sha256(body.token)) !== AB_HASH) return json({ error: 'no' }, 403);
    const model = MODELOS_AB.has(body.model) ? body.model : 'claude-haiku-4-5';
    const imgs = (Array.isArray(body.images) ? body.images : []).filter((x: any) => x?.data).slice(0, 6);
    const content: any[] = [];
    imgs.forEach((im: any, i: number) => {
      content.push({ type: 'text', text: `Foto ${i + 1}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } });
    });
    content.push({ type: 'text', text: String(body.text || '').trim() || 'Registra lo de las fotos.' });
    const t0 = Date.now();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 4000,
        system: analyzeSystemV3(body.weight_kg ?? null, body.today || '2026-11-14', body.time || '14:00', body.meal_type || 'lunch', imgs.length, Number(body.open_offset) || 0),
        tools: [REGISTER_TOOL_V3], ...ajustesModelo(model, 'register_items'),
        messages: [{ role: 'user', content }],
      }),
    });
    const ms = Date.now() - t0;
    if (!resp.ok) return json({ error: `Anthropic ${resp.status}: ${(await resp.text()).slice(0, 400)}`, ms });
    const data = await resp.json();
    const tu = (data.content ?? []).find((b: any) => b.type === 'tool_use');
    return json({ model, ms, usage: data.usage, stop_reason: data.stop_reason, items: (tu?.input?.items ?? []).map(limpiaV3), raw_ok: !!tu });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
