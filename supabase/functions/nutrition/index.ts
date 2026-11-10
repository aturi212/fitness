// ============================================================
// Edge Function "nutrition" — Análisis nutricional de la app FITNESS
// ------------------------------------------------------------
// Dos modos (POST JSON):
//  - { mode:'analyze', text }                        → analiza una descripción de comida
//  - { mode:'analyze', image:{ data, media_type } }  → analiza una FOTO de comida (visión)
//      ↳ devuelve { items:[{ description, protein_g, carbs_g, fat_g, fiber_g, kcal }] }
//      ↳ con v:2, los items de una ETIQUETA traen además { label:{ name, per100,
//        per_serving, serving_g }, grams } o, si no dijo cuánto, needs_grams:true
//  - { mode:'recalc', text, previous:{ description, protein_g, … } }
//      ↳ la descripción de una comida YA apuntada se ha corregido (p. ej. se
//        añade «tomate» que la foto no vio): devuelve { item } con el total nuevo
//  - { mode:'chat', messages, context }              → chat de nutrición (con contexto del día/semana)
//      ↳ devuelve { reply }
// La función NO escribe en la BD: analiza y devuelve; la app inserta
// en `meals` con el client del usuario (RLS normal).
// Auth: igual que "chat" — verify JWT desactivado, la función valida
// el JWT del usuario con getUser (401 si no hay sesión).
// El perfil del usuario se lee de `profiles`: NADA escrito a fuego.
// Topes y registro de uso: ../_shared/ai_usage.ts. Al llegar al tope responde
// 200 con { error, limit:{ reason, feature } }: la app saca su ventana de tope
// (las versiones viejas enseñan `error` tal cual).
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkLimits, logUsage, type Kind } from '../_shared/ai_usage.ts';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// MODELO PROPIO, separado del Coach (que usa CHAT_MODEL). Contar macros de un
// plato o de una foto es una tarea acotada: la hace igual de bien el modelo
// pequeño y cuesta una fracción. Cada plato que se apunta pasa por aquí, así
// que es donde más se nota; y cambiar el modelo del Coach ya no lo encarece.
const MODEL = Deno.env.get('NUTRITION_MODEL') ?? 'claude-haiku-4-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Herramienta forzada en modo analyze → salida estructurada garantizada
const REGISTER_TOOL = {
  name: 'register_meals',
  description: 'Registra los alimentos identificados con sus macronutrientes estimados.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Nombre corto del alimento/plato en español, con la cantidad estimada. Ej: "Pechuga de pollo (200 g)"' },
            protein_g: { type: 'number' },
            carbs_g: { type: 'number' },
            fat_g: { type: 'number' },
            fiber_g: { type: 'number' },
            kcal: { type: 'number' },
            label: {
              type: 'object',
              description: 'SOLO si hay una tabla nutricional (en la foto o porque el usuario dicta sus valores). Copia los números EXACTOS de la tabla, sin estimar ni redondear. Si no hay tabla, no pongas este campo.',
              properties: {
                name: { type: 'string', description: 'Nombre del producto, sin cantidad. Ej: "Chocolate negro Nestlé"' },
                basis: { type: 'string', enum: ['per_100', 'per_serving'], description: 'per_100 si la tabla da los valores por 100 g o 100 ml (usa esa columna siempre que exista); per_serving solo si únicamente los da por ración' },
                serving_g: { type: ['number', 'null'], description: 'Gramos (o ml) de una ración o unidad, si la etiqueta lo dice. Si no, null' },
                kcal: { type: 'number' },
                protein_g: { type: 'number' },
                carbs_g: { type: 'number' },
                fat_g: { type: 'number' },
                fiber_g: { type: 'number', description: '0 si la tabla no la trae' },
              },
              required: ['name', 'basis', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
            },
            grams: { type: ['number', 'null'], description: 'Solo con label: gramos (o ml) que DICE el usuario que se ha comido. Si dice unidades o raciones y la etiqueta da su peso, multiplícalo. Si no lo dice, null: NO lo supongas.' },
            servings: { type: ['number', 'null'], description: 'Solo con label y basis per_serving sin serving_g: cuántas raciones o unidades dice que se ha comido. Si no lo dice, null.' },
          },
          required: ['description', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'kcal'],
        },
      },
    },
    required: ['items'],
  },
};

// El peso solo se usa para estimar el tamaño de una ración cuando no lo dicen.
const analyzeSystem = (pesoKg?: number | null) =>
  `Eres un nutricionista experto en composición de alimentos. Recibes la descripción (texto o foto) de lo que ha comido el usuario y estimas sus macronutrientes.

REGLAS:
- Registra SIEMPRE el resultado llamando a la herramienta register_meals. Nada de texto suelto.
- Separa en items los alimentos claramente distintos (ej: "pollo con arroz y una manzana" → 3 items o 2 si van juntos en el plato; usa criterio de plato).
- Si no se indica cantidad, estima una ración normal para un adulto${pesoKg ? ` de ${pesoKg} kg` : ''} y REFLEJA la cantidad estimada en la descripción entre paréntesis.
- En fotos de comida: identifica el plato/producto y estima la ración por el tamaño visible.
- Valores en gramos (protein_g, carbs_g, fat_g, fiber_g) y kcal totales del item. Sé realista, no redondees todo a cero.
- Si la entrada no parece comida, devuelve items: [].

ETIQUETAS NUTRICIONALES (foto de la tabla de un envase, o valores que te dicta):
- Rellena «label» copiando los números tal cual de la tabla. Si hay columna por 100 g / 100 ml, usa esa (basis per_100). No estimes nada a ojo: la etiqueta manda.
- La cantidad la dice el usuario («me he comido 30 g», «2 galletas», «medio paquete de 200 g»). Ponla en «grams» (o en «servings» si solo hay valores por ración sin peso). Si no la dice, déjala en null: la app se la preguntará. No inventes la ración ni uses la de la etiqueta por tu cuenta.
- Las cuentas las hace la app con label y grams: los macros del item puedes dejarlos en 0.
- Un item por producto.`;

// ---------- Etiquetas: la cuenta la hace el código, no el modelo ----------
// El modelo copia la tabla (por 100 g o por ración) y la cantidad que dice el
// usuario; aquí se escala. Con v>=2 (la app nueva) se devuelve además la
// etiqueta por 100 g y, si falta la cantidad, needs_grams: la app la pregunta
// y hace la cuenta ella, sin volver a llamar a la IA. A las versiones viejas
// de la app, sin cantidad, se les apunta una ración (o 100 g) y lo dice.
const pos = (v: unknown) => Math.max(0, Number(v) || 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const MAC = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'] as const;
const escala = (vals: Record<string, number>, f: number) => Object.fromEntries(MAC.map((k) => [k, vals[k] * f]));
function conEtiqueta(it: any, v2: boolean) {
  const l = it?.label;
  if (!l || typeof l !== 'object' || !(pos(l.kcal) || pos(l.protein_g) || pos(l.carbs_g) || pos(l.fat_g))) return null;
  const name = String(l.name || it.description || 'Producto').replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 100);
  const serving = pos(l.serving_g) || null;
  const vals: Record<string, number> = Object.fromEntries(MAC.map((k) => [k, pos(l[k])]));
  let per100: Record<string, number> | null = null;
  let perServing: Record<string, number> | null = null;
  if (l.basis === 'per_serving') {
    perServing = vals;
    if (serving) per100 = escala(vals, 100 / serving);
  } else per100 = vals;
  let grams = pos(it.grams) || null;
  const servings = pos(it.servings) || null;
  if (!grams && servings && serving) grams = servings * serving;

  let total: Record<string, number> | null = null;
  let qty = '';
  if (per100 && grams) { total = escala(per100, grams / 100); qty = `${r1(grams)} g`; }
  else if (perServing && servings) { total = escala(perServing, servings); qty = `${servings} ${servings === 1 ? 'ración' : 'raciones'}`; }

  const redondea = (o: Record<string, number> | null) => o && Object.fromEntries(MAC.map((k) => [k, r1(o[k])]));
  const label = { name, per100: redondea(per100), per_serving: redondea(perServing), serving_g: serving };
  if (!total) {
    if (v2) return { description: name, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, label, needs_grams: true };
    // App vieja: una ración si se sabe; si no, 100 g. Queda escrito en la descripción.
    const g = serving || 100;
    total = per100 ? escala(per100, g / 100) : vals;
    qty = per100 ? `${g} g, cantidad supuesta` : '1 ración, supuesta';
  }
  return {
    description: `${name} (${qty})`.slice(0, 120),
    kcal: Math.round(total.kcal),
    protein_g: r1(total.protein_g), carbs_g: r1(total.carbs_g), fat_g: r1(total.fat_g), fiber_g: r1(total.fiber_g),
    ...(v2 ? { label, grams: grams ? r1(grams) : null, servings: grams ? null : servings } : {}),
  };
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

    const body = await req.json();

    // Topes ANTES de llamar a la API
    const kind: Kind | null = body.mode === 'analyze' ? (body.image?.data ? 'photo' : 'text')
      : body.mode === 'recalc' ? 'text'
      : body.mode === 'chat' ? 'nutritionist' : null;
    if (kind) {
      const tope = await checkLimits(user.id, kind);
      if (tope) return json({ error: tope.msg, limit: { reason: tope.reason, feature: tope.feature } });
    }

    // Ficha del usuario: el prompt no lleva datos de nadie escritos a fuego
    const { data: perfil } = await sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    const OBJETIVOS: Record<string, string> = {
      'perder-grasa': 'perder grasa',
      'ganar-musculo': 'ganar músculo',
      'recomposicion': 'recomposición (bajar grasa manteniendo masa magra)',
      'salud-forma': 'salud y forma física',
      'mejorar-entrenos': 'mejorar sus entrenamientos',
      'competicion': 'prepararse para competir',
      'mantenerme': 'mantenerse y estar sano',
    };
    const edadDe = (p: any): number | null => {
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
    };
    const perfilTexto = (() => {
      if (!perfil) return 'No tienes datos suyos: no supongas nada sobre su peso, su objetivo ni su nivel.';
      const t: string[] = [];
      if (perfil.display_name) t.push(`Se llama ${perfil.display_name}`);
      if (perfil.sex) t.push(perfil.sex === 'mujer' ? 'mujer' : 'hombre');
      const edad = edadDe(perfil);
      if (edad) t.push(`${edad} años`);
      if (perfil.height_cm) t.push(`${perfil.height_cm} cm`);
      if (perfil.weight_kg) t.push(`${perfil.weight_kg} kg`);
      const objetivos = Array.isArray(perfil.goals) && perfil.goals.length
        ? perfil.goals : (perfil.goal ? [perfil.goal] : []);
      if (objetivos.length) {
        t.push(`busca: ${objetivos.map((g: string) => OBJETIVOS[g] ?? g).join(', ')}`);
      }
      if (perfil.training_days) t.push(`entrena ${perfil.training_days} días por semana`);
      return t.length ? t.join(' · ') + '.' : 'Su ficha está vacía: no supongas nada sobre él.';
    })();

    const callAnthropic = async (payload: Record<string, unknown>) => {
      if (!kind) throw new Error('mode inválido');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, ...payload }),
      });
      if (!resp.ok) {
        const errTxt = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${errTxt.slice(0, 300)}`);
      }
      const data = await resp.json();
      await logUsage(user.id, 'nutrition', kind, data.usage, MODEL);
      return data;
    };

    if (body.mode === 'analyze') {
      const content: any[] = [];
      if (body.image?.data) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: body.image.media_type || 'image/jpeg', data: body.image.data },
        });
        content.push({ type: 'text', text: body.text?.trim() || 'Analiza la comida de la foto y registra sus macronutrientes.' });
      } else if (body.text?.trim()) {
        content.push({ type: 'text', text: body.text.trim() });
      } else {
        return json({ error: 'Falta text o image' }, 400);
      }

      const data = await callAnthropic({
        max_tokens: 1500,
        system: analyzeSystem(perfil?.weight_kg ?? null),
        tools: [REGISTER_TOOL],
        tool_choice: { type: 'tool', name: 'register_meals' },
        messages: [{ role: 'user', content }],
      });
      const toolUse = (data.content ?? []).find((b: any) => b.type === 'tool_use');
      const items = (toolUse?.input?.items ?? [])
        .filter((it: any) => it && (it.description || it.label?.name))
        .map((it: any) => conEtiqueta(it, body.v >= 2) ?? ({
          description: String(it.description).slice(0, 120),
          protein_g: Math.max(0, Number(it.protein_g) || 0),
          carbs_g: Math.max(0, Number(it.carbs_g) || 0),
          fat_g: Math.max(0, Number(it.fat_g) || 0),
          fiber_g: Math.max(0, Number(it.fiber_g) || 0),
          kcal: Math.max(0, Number(it.kcal) || 0),
        }));
      return json({ items });
    }

    if (body.mode === 'recalc') {
      const text = String(body.text ?? '').trim();
      if (!text) return json({ error: 'Falta text' }, 400);
      const prev = body.previous ?? {};
      const n = (v: unknown) => Math.max(0, Number(v) || 0);
      const referencia = prev.description
        ? `\n\nANTES estaba apuntada como «${String(prev.description).slice(0, 200)}» con ${n(prev.protein_g)} g proteína, ${n(prev.carbs_g)} g hidratos, ${n(prev.fat_g)} g grasa, ${n(prev.fiber_g)} g fibra y ${n(prev.kcal)} kcal. Usa esos valores como referencia para las raciones de lo que no ha cambiado y ajusta solo lo que la descripción nueva añade, quita o corrige.`
        : '';
      const data = await callAnthropic({
        max_tokens: 800,
        system: analyzeSystem(perfil?.weight_kg ?? null)
          + `\n- MODO CORRECCIÓN: es UNA comida ya apuntada cuya descripción se ha corregido. Devuelve UN SOLO item con el total del plato corregido y la descripción tal como la ha escrito el usuario.`,
        tools: [REGISTER_TOOL],
        tool_choice: { type: 'tool', name: 'register_meals' },
        messages: [{ role: 'user', content: `Descripción corregida: ${text}${referencia}` }],
      });
      const toolUse = (data.content ?? []).find((b: any) => b.type === 'tool_use');
      const items = (toolUse?.input?.items ?? []).filter((it: any) => it).map((it: any) => conEtiqueta(it, false) ?? it);
      if (!items.length) return json({ error: 'No he reconocido comida en esa descripción.' });
      // Si aun así parte el plato, se suman: en la BD es una sola fila.
      const suma = (k: string) => Math.round(items.reduce((a: number, it: any) => a + n(it[k]), 0) * 10) / 10;
      return json({
        item: {
          description: text.slice(0, 120),
          protein_g: suma('protein_g'), carbs_g: suma('carbs_g'), fat_g: suma('fat_g'),
          fiber_g: suma('fiber_g'), kcal: Math.round(suma('kcal')),
        },
      });
    }

    if (body.mode === 'chat') {
      const msgs = (Array.isArray(body.messages) ? body.messages : [])
        .slice(-12)
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
      if (!msgs.length) return json({ error: 'messages vacío' }, 400);
      const data = await callAnthropic({
        max_tokens: 700,
        system: `Eres el nutricionista del usuario dentro de su app de fitness (ONIX). Respondes SIEMPRE en español, breve, práctico y concreto (2-5 frases; listas cortas solo si aportan). Nada de saludos ni disclaimers. Sin formato markdown (texto plano). Prioridades: cubrir proteína, no pasarse de grasa, fibra suficiente, adherencia realista.

QUIÉN ES QUIEN TE HABLA: ${perfilTexto}
No te inventes datos suyos que no estén aquí.

CONTEXTO REAL DE SU APP (úsalo para responder con sus números): ${JSON.stringify(body.context ?? {})}`,
        messages: msgs,
      });
      const reply = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
      return json({ reply });
    }

    return json({ error: 'mode inválido' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
