// ============================================================
// Edge Function "nutrition" — Análisis nutricional de la app FITNESS
// ------------------------------------------------------------
// Dos modos (POST JSON):
//  - { mode:'analyze', text }                        → analiza una descripción de comida
//  - { mode:'analyze', image:{ data, media_type } }  → analiza una FOTO de comida (visión)
//      ↳ devuelve { items:[{ description, protein_g, carbs_g, fat_g, fiber_g, kcal }] }
//  - { mode:'chat', messages, context }              → chat de nutrición (con contexto del día/semana)
//      ↳ devuelve { reply }
// La función NO escribe en la BD: analiza y devuelve; la app inserta
// en `meals` con el client del usuario (RLS normal).
// Auth: igual que "chat" — verify JWT desactivado, la función valida
// el JWT del usuario con getUser (401 si no hay sesión).
// El perfil del usuario se lee de `profiles`: NADA escrito a fuego.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

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
- En fotos: identifica el plato/producto y estima la ración por el tamaño visible. Si hay etiqueta nutricional visible, úsala.
- Valores en gramos (protein_g, carbs_g, fat_g, fiber_g) y kcal totales del item. Sé realista, no redondees todo a cero.
- Si la entrada no parece comida, devuelve items: [].`;

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
      return resp.json();
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
        .filter((it: any) => it && it.description)
        .map((it: any) => ({
          description: String(it.description).slice(0, 120),
          protein_g: Math.max(0, Number(it.protein_g) || 0),
          carbs_g: Math.max(0, Number(it.carbs_g) || 0),
          fat_g: Math.max(0, Number(it.fat_g) || 0),
          fiber_g: Math.max(0, Number(it.fiber_g) || 0),
          kcal: Math.max(0, Number(it.kcal) || 0),
        }));
      return json({ items });
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
