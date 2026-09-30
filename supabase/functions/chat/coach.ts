// ============================================================
// Lo que el Coach le manda a la API en cada ronda: herramientas, prompt del
// sistema y la lectura del stream. Aparte de index.ts para que la prueba de
// humo de un modelo nuevo use EXACTAMENTE lo mismo que el Coach de verdad.
// ============================================================

// ---------- Herramientas expuestas a Claude ----------
// Búsqueda web: herramienta de SERVIDOR (la ejecuta Anthropic, no runTool).
// Variante básica: la de filtrado dinámico mete bloques de ejecución de código
// en el stream y aquí no hacen falta.
export const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };
export const TOOLS = [
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
    name: 'get_exercise_guide',
    description:
      'Devuelve la ficha técnica de uno o varios ejercicios del catálogo: músculos, preparación, fases, respiración, errores típicos, variantes más fácil / más difícil / sin material y aviso de seguridad. Es el MISMO texto que el usuario ve en la ficha del ejercicio de su app: úsalo para corregirle la técnica con esas palabras y no con otras.',
    input_schema: {
      type: 'object',
      properties: {
        exercise_ids: { type: 'array', items: { type: 'string' }, description: 'ids del catálogo, p.ej. ["romanian-deadlift"]' },
      },
      required: ['exercise_ids'],
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
export const TOOLS_CACHEADAS = TOOLS.map((t, i) =>
  (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));

// ---------- Prompt del sistema ----------
// Va PARTIDO EN DOS para que el caché funcione: este primer bloque es idéntico
// para todos los usuarios y todas las peticiones, así que se cachea una vez y
// se reaprovecha siempre. Lo que cambia (fecha, ficha, plan) va en el segundo.
// Si tocas algo de aquí, la primera llamada de cada usuario paga caché nuevo.
export const SYSTEM_BASE = `Eres el Coach: el entrenador personal del usuario dentro de su app de fitness (ONIX). Respondes SIEMPRE en español, breve y directo, como un buen entrenador: claro, motivador sin ñoñerías, y técnico cuando hace falta.

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
- Para dudas o correcciones de técnica usa get_exercise_guide: es la ficha que él ve en la app, así que corrígele con las mismas palabras.
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
export const GUION_PRIMERA = `

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

// ---------- Una ronda contra la API, en streaming ----------
// Devuelve el mensaje recompuesto (content), el stop_reason y el usage.
// `send` recibe los eventos para la app: texto según llega y "buscando".
//
// CACHÉ: tres puntos explícitos (última herramienta, SYSTEM_BASE y el
// contexto) y el cuarto AUTOMÁTICO (cache_control en la raíz de la petición):
// la API lo pone en el último bloque que se pueda cachear del último mensaje y
// lo va moviendo sola. Así cada ronda del bucle de herramientas lee de caché
// todo lo anterior, y no hay que tocar mensajes ya enviados para quitar el
// punto viejo (tocarlos invalidaría la caché y los bloques de razonamiento).
export async function ronda(
  o: { key: string; model: string; maxTokens: number; system: any[]; tools: any[]; messages: any[]; effort?: string },
  send: (ev: any) => void,
): Promise<{ ok: false; status: number; error: string } | { ok: true; content: any[]; stopReason: string; usage: any }> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': o.key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: o.model, max_tokens: o.maxTokens,
      system: o.system, tools: o.tools, messages: o.messages, stream: true,
      cache_control: { type: 'ephemeral' },
      ...(o.effort ? { output_config: { effort: o.effort } } : {}),
    }),
  });
  if (!resp.ok || !resp.body) {
    const errTxt = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, error: errTxt.slice(0, 300) };
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

  // Un bloque de texto vacío hace que la API rechace el mensaje al
  // reenviarlo. Y un bloque de razonamiento sin firma tampoco vale.
  const content = bloques.filter((b: any) => b
    && (b.type !== 'text' || (b.text ?? '').trim())
    && (b.type !== 'thinking' || b.signature));
  // Texto con citas de la búsqueda: se reenvían; un `citations` vacío, fuera.
  content.forEach((b: any) => { if (b.type === 'text' && !b.citations?.length) delete b.citations; });
  return { ok: true, content, stopReason, usage };
}
