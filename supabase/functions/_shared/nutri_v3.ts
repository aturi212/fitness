// ============================================================
// Registro de comida v3: esquema, prompt y limpieza, compartidos por
// `nutrition` (producción) y `nutrition-ab` (A/B de modelos, temporal).
// La IA LEE y ESTIMA (referencias por 100 g / unidad y la cantidad dicha);
// la app CALCULA. Ver index.html, bloque <nutri-calc>.
// ============================================================
const MAC = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'] as const;

// A/B de modelos (solo usuarios exentos: Adrián y Julia) con body.model
export const MODELOS_AB = new Set(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
// Cómo pedir la herramienta según el modelo (Sonnet 5.5 no admite forzarla)
export function ajustesModelo(model: string, tool: string): Record<string, unknown> {
  if (model.startsWith('claude-sonnet-5')) {
    return { tool_choice: { type: 'auto' }, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  }
  if (model.startsWith('claude-haiku-5')) {
    return { tool_choice: { type: 'tool', name: tool }, thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  }
  return { tool_choice: { type: 'tool', name: tool } };
}

// ============ v3 · La IA LEE y ESTIMA; la APP CALCULA ============
// Por producto devuelve sus valores de REFERENCIA (por 100 g, por unidad o el
// total que dice el usuario) y la cantidad que ha entendido. Ninguna
// multiplicación aquí ni en el modelo: la app hace kcal = ref × g / 100.
const REF_PROPS = {
  kcal: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' },
  fat_g: { type: 'number' }, fiber_g: { type: 'number', description: '0 si no consta' },
};
export const REGISTER_TOOL_V3 = {
  name: 'register_items',
  description: 'Registra lo que ha comido el usuario: un elemento por plato o producto, con sus valores de referencia y la cantidad consumida. NO calcules totales.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nombre corto y limpio del plato o producto, con marca si se sabe, SIN cantidad ni comentarios del usuario. Ej: "Chocolate con leche Mercadona", "Ensalada de garbanzos con feta"' },
            photo: { type: ['integer', 'null'], description: 'Número de la foto de la que sale (1, 2, 3… en el orden recibido). null si sale del texto' },
            source: { type: 'string', enum: ['label', 'user', 'estimate'], description: 'label: tabla nutricional de la foto; user: valores que da el usuario; estimate: estimación tuya' },
            basis: { type: 'string', enum: ['per_100g', 'per_unit', 'total'], description: 'per_100g: valores por 100 g (o 100 ml); per_unit: por unidad/ración; total: totales que da el usuario para lo que se ha comido' },
            ref: { type: 'object', properties: REF_PROPS, required: ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'], description: 'Valores para la base indicada. De la etiqueta: copiados tal cual. Estimados: valores típicos de tablas de composición (BEDCA/USDA), por 100 g del plato tal como se come' },
            unit_g: { type: ['number', 'null'], description: 'Gramos de una unidad/ración si se sabe (etiqueta o típico: 1 galleta María ≈ 6 g, 1 huevo ≈ 55 g). Si no, null' },
            package_g: { type: ['number', 'null'], description: 'Peso neto del envase si aparece. Si no, null' },
            amount: {
              type: 'object',
              description: 'Cantidad consumida que DICE el usuario. Rellena solo UNO. Si no lo dice: en etiquetas todo null (la app lo preguntará); en platos estimados, grams con una ración normal y estimated=true',
              properties: {
                grams: { type: ['number', 'null'] },
                ml: { type: ['number', 'null'] },
                units: { type: ['number', 'null'], description: 'unidades o raciones (1 galleta, 2 lonchas, media ración = 0.5)' },
                percent: { type: ['number', 'null'], description: 'porcentaje del envase, 0-100 («la mitad» = 50)' },
                estimated: { type: 'boolean', description: 'true si la cantidad la has estimado tú' },
              },
              required: ['grams', 'ml', 'units', 'percent', 'estimated'],
            },
            meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'other'] },
            day_offset: { type: 'integer', description: '0 = hoy, -1 = ayer, -2 = anteayer…' },
          },
          required: ['name', 'photo', 'source', 'basis', 'ref', 'unit_g', 'package_g', 'amount', 'meal_type', 'day_offset'],
        },
      },
    },
    required: ['items'],
  },
};
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MOMENTOS: Record<string, string> = { breakfast: 'desayuno', lunch: 'comida', dinner: 'cena', other: 'otros' };
export const analyzeSystemV3 = (pesoKg: number | null, hoy: string, hora: string, momento: string, nFotos: number, abierto = 0) => {
  const d = new Date(hoy + 'T12:00:00Z');
  return `Eres un nutricionista experto en composición de alimentos. Registras lo que ha comido el usuario llamando SIEMPRE a la herramienta register_items (nunca respondas con texto suelto).

CONTEXTO: hoy es ${DIAS[d.getUTCDay()]} ${hoy}, son las ${hora}. En la app tiene abierto ${abierto === 0 ? 'el día de hoy' : abierto === -1 ? 'el día de ayer' : `el día de hace ${-abierto} días`} y el momento «${MOMENTOS[momento] ?? 'otros'}». ${nFotos ? `Te manda ${nFotos} foto${nFotos > 1 ? 's' : ''}, numeradas 1..${nFotos} en el orden recibido.` : 'No hay fotos.'}${pesoKg ? ` Pesa ${pesoKg} kg (solo para estimar raciones que no diga).` : ''}

NO CALCULES TOTALES. Por cada elemento das sus valores de REFERENCIA y la cantidad que ha comido; la app hace la cuenta.
- Etiqueta en la foto: source label. Copia los números de la tabla tal cual. Usa la columna por 100 g / 100 ml (basis per_100g) siempre que exista; per_unit solo si únicamente viene por ración (y pon unit_g si dice su peso). Pon package_g si se ve el peso neto.
- El usuario da valores («100 g son 12 de proteína…», una tabla pegada de ChatGPT, «esto son 450 kcal y 30 g de proteína»): source user. Si son por 100 g, basis per_100g; si son totales de lo que se ha comido, basis total con amount.units = 1. Respeta sus números exactos: no los cambies.
- Sin etiqueta ni valores: source estimate, basis per_100g con valores típicos del plato tal como se come, y amount.grams con lo que diga o una ración normal (estimated true).
- Cantidad: la que DICE el usuario («de la 2, 20 g», «una galleta», «la mitad», «un vaso» ≈ 200 ml, «una cucharada» ≈ 15 g). Rellena solo un campo de amount. En etiquetas sin cantidad dicha, todo null.
- Si la base es per_100g y la cantidad va en unidades (cucharadas, rebanadas, piezas, raciones, «un plato»), pon SIEMPRE unit_g con el peso de una unidad (1 cucharada de aceite ≈ 13,5 g; 1 rebanada de pan ≈ 30 g; 1 huevo ≈ 55 g); sin unit_g la app no puede calcular. Si no hay unidad clara, da amount.grams.
- Si la etiqueta trae columna por 100 g y por unidad, usa la de 100 g (basis per_100g) y pon unit_g con el peso de la unidad.
- Un elemento por PLATO: lo que va junto en el plato es un solo elemento («Ensalada de garbanzos con feta y aceitunas», valores por 100 g del conjunto y su peso total). Separa solo lo que se come aparte: bebida, postre, pan, y cada producto de foto distinto.
- Cada elemento lleva photo (número de foto) o null si sale del texto.
- meal_type y day_offset (respecto a HOY): deduce de lo que diga («ayer cené…» → dinner, -1; «esta mañana» → breakfast, 0; encabezados «desayuno: … comida: …» reparten). Si no dice nada, el momento abierto y day_offset ${abierto}.
- Nombre limpio: sin cantidades ni frases del usuario.
- Si no hay comida, items: [].`;
};
// Limpia lo que devuelve el modelo (números válidos, límites razonables)
export function limpiaV3(it: any) {
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
  const ref: Record<string, number> = Object.fromEntries(MAC.map((k) => [k, Math.max(0, Number(it?.ref?.[k]) || 0)]));
  const a = it?.amount || {};
  const pos0 = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
  const basis = ['per_100g', 'per_unit', 'total'].includes(it?.basis) ? it.basis : 'per_100g';
  const day = Math.max(-7, Math.min(0, Math.round(Number(it?.day_offset) || 0)));
  return {
    name: String(it?.name || 'Comida').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Comida',
    photo: pos0(it?.photo) ? Math.round(Number(it.photo)) : null,
    source: ['label', 'user', 'estimate'].includes(it?.source) ? it.source : 'estimate',
    basis, ref,
    unit_g: pos0(it?.unit_g), package_g: pos0(it?.package_g),
    amount: {
      grams: pos0(a.grams), ml: pos0(a.ml), units: pos0(a.units),
      percent: pos0(a.percent) !== null ? Math.min(100, Number(a.percent)) : null,
      estimated: !!a.estimated,
    },
    meal_type: ['breakfast', 'lunch', 'dinner', 'other'].includes(it?.meal_type) ? it.meal_type : null,
    day_offset: day,
  };
}

