/* ============================================================
   PLAN DE ENTRENAMIENTO Y RUTINAS
   ------------------------------------------------------------
   ESTE ES EL ARCHIVO QUE EDITA EL CHAT "PERSONAL TRAINER".
   Aquí vive: objetivos, plan macro, calendario semanal y las
   rutinas concretas (ejercicios, series, reps, descansos).

   Estructura:
   - goals: objetivos del usuario (corto y largo plazo)
   - plan: bloques macro de entrenamiento (mesociclos)
   - currentPlan: metadata del bloque vigente
   - weeklySchedule: qué rutina toca cada día (0=Dom, 1=Lun, ...)
   - routines: definición de cada rutina por id
       - exerciseId DEBE existir en data/exercises.js
   ============================================================ */

window.ROUTINES = {

  // ===== OBJETIVOS =====
  // Recalibrados con Adrián el 2026-06-01 tras medición pro en farmacia.
  // Perfil real: 1,78 m / 83,7 kg / 20,9% grasa / 66,3 kg magra. 31 años.
  // Prioridad: recomposición + adherencia. Reconciliarse con el deporte
  // tras un año algo desconectado. Plan Junio-Julio-Agosto (parón sept).
  goals: {

    shortTerm: {
      horizon: '13 semanas (1 jun → 30 ago 2026)',
      deadline: '2026-08-30',
      targets: [
        { metric: 'Adherencia',        target: '≥80% sesiones completadas', notes: 'Lo no-negociable: ir al gym los días planificados.' },
        { metric: 'Grasa corporal',    target: '20,9% → ~18,5%', notes: 'Medir en misma báscula (farmacia) y mismas condiciones. -2,4 puntos en 13 sem.' },
        { metric: 'Masa magra',        target: '≥66 kg',         notes: 'Mantener o subir ligeramente. No perder músculo en el proceso.' },
        { metric: 'Fuerza básicos',    target: '+5-10%',         notes: 'Sentadilla, press banca, peso muerto rumano y remo. Medir en sem 1 y sem 13.' },
        { metric: 'Dominada',          target: 'Primera negativa controlada (3-5s bajada)', notes: 'Vía remo invertido → dead hang → negativas.' },
        { metric: 'Cardio 5k',         target: 'Correr 5k seguidos a ritmo cómodo', notes: 'A final de agosto. Progresión en día outdoor.' },
      ]
    },

    longTerm: {
      horizon: '12 meses',
      deadline: '2027-06-01',
      targets: [
        { metric: 'Grasa corporal',    target: '~14-15%',                  notes: 'Abdomen marcado, dentro de rango sano-deportivo.' },
        { metric: 'Masa magra',        target: '68-70 kg',                 notes: '+2-4 kg de músculo respecto al punto de partida.' },
        { metric: 'Sentadilla',        target: '1,2 x peso (~100 kg)',     notes: 'PR de fuerza relativa.' },
        { metric: 'Press banca',       target: '1,0 x peso (~84 kg)',      notes: 'PR de fuerza relativa.' },
        { metric: 'Peso muerto rumano',target: '1,5 x peso (~125 kg)',     notes: 'PR de fuerza relativa.' },
        { metric: 'Dominadas',         target: '8-10 estrictas',           notes: 'Sin asistencia, ROM completo.' },
        { metric: 'Cardio 5k',         target: '<25 min',                  notes: 'Carrera continua a buen ritmo.' },
        { metric: 'Movilidad',         target: 'Tocar punta pies + sentadilla profunda sin compensar', notes: 'Hábito de movilidad consolidado.' },
      ]
    }

  },

  // ===== PLAN MACRO (1 jun → 30 ago 2026, parón de septiembre) =====
  // 13 semanas en 3 bloques progresivos (Plan A: subimos días gradualmente).
  // Filosofía: adherencia primero (junio), después intensidad (julio-agosto).
  plan: {
    name: 'Plan Junio-Agosto 2026 (Reconciliación + Recomposición)',
    startDate: '2026-06-01',
    endDate: '2026-08-30',
    notes: 'Adrián vuelve tras ~1 año algo desconectado. Septiembre = parón (viaje/vacaciones). Estrategia progresiva: 2 → 3 → 3+1 días por semana. Re-evaluar a final de junio antes de subir a 3 días.',
    blocks: [
      {
        id: 'block-1-adaptacion',
        name: 'Bloque 1 — Adaptación',
        startDate: '2026-06-01',
        endDate: '2026-06-28',
        weeks: 4,
        scheme: '2 días gym (FB A + FB B) + 1 día outdoor opcional',
        focus: 'Crear hábito, técnica antes que carga. RPE 7-8 en BÁSICOS pesados (sentadilla, banca, PM rumano, remo, dominada) — la última rep cuesta pero técnica limpia. RPE 9-10 / cerca del fallo en ACCESORIOS (curls, laterales, tríceps, hip thrust, plancha). Última serie de cualquier ejercicio: libre, al fallo si apetece. Foco mental: que el gym vuelva a ser un sitio cómodo. Hito: ≥7 sesiones gym completadas en el mes.'
      },
      {
        id: 'block-2-carga',
        name: 'Bloque 2 — Carga',
        startDate: '2026-06-29',
        endDate: '2026-07-26',
        weeks: 4,
        scheme: '3 días gym (FB A / B / C) + 1 día outdoor opcional',
        focus: 'Subir frecuencia a 3 sesiones (provisional: FB A/B/C, a confirmar el 28 jun según cómo haya ido junio). RPE 7-8. Hito del mes: +5% en los 4 levantamientos principales (sentadilla, banca, peso muerto rumano, remo).'
      },
      {
        id: 'block-3-intensificacion',
        name: 'Bloque 3 — Intensificación + Deload',
        startDate: '2026-07-27',
        endDate: '2026-08-30',
        weeks: 5,
        scheme: '3 días gym + 1 día outdoor FIJO (4 días/sem). Semana 5 = deload',
        focus: 'Cargas más altas (RPE 8). Outdoor fijo: añade cardio (5k) y calistenia (negativas de dominada). Sem 1-4 progresar, sem 5 (24-30 ago) descarga (volumen y cargas -40%). Hito de bloque: grasa hacia 18,5%, magra ≥66 kg, negativa de dominada controlada, correr 5k seguidos.'
      }
    ]
  },

  // ===== BLOQUE VIGENTE =====
  currentPlan: {
    name: 'Bloque 1 — Adaptación (Junio 2026)',
    startDate: '2026-06-01',
    endDate: '2026-06-28',
    status: 'active',
    notes: '2 días gym (FB A lunes + FB B jueves) + outdoor opcional sábado. INTENSIDAD: RPE 7-8 en básicos pesados (sentadilla, banca, PM rumano, remo, dominada) → técnica limpia, no fallo. RPE 9-10 / cerca del fallo en accesorios (curls, laterales, tríceps, hip thrust, plancha). Última serie libre, al fallo si apetece. Doble progresión: empieza en el rango bajo de reps, sube reps semana a semana; sólo sube peso al tocar techo del rango. Objetivo del mes: ≥7 sesiones de gym + 0 lesiones. Re-evaluar el 28 jun antes de pasar a 3 días.'
  },

  // ===== CALENDARIO SEMANAL =====
  // 0=Domingo, 1=Lunes, 2=Martes, ..., 6=Sábado
  weeklySchedule: {
    0: 'rest',          // Domingo
    1: 'full-body-a',   // Lunes
    2: 'rest',          // Martes
    3: 'rest',          // Miércoles
    4: 'full-body-b',   // Jueves
    5: 'rest',          // Viernes
    6: 'outdoor'        // Sábado (opcional)
  },

  // ===== RUTINAS =====
  routines: {

    'full-body-a': {
      name: 'Full Body A',
      tag: 'FB-A',
      muscleGroups: ['Cuádriceps', 'Pecho', 'Espalda', 'Hombro', 'Bíceps', 'Tríceps', 'Core'],
      exercises: [
        { exerciseId: 'back-squat',           sets: 4, repsTarget: '6-8',   restSec: 90,  notes: 'Si la profunda incomoda, empezar con sentadilla goblet o prensa 45° las primeras 2-3 semanas.' },
        { exerciseId: 'bench-press-barbell',  sets: 4, repsTarget: '6-8',   restSec: 90,  notes: 'Básico → RPE 7-8 (técnica limpia, no fallo). Pies firmes, escápulas retraídas. Última serie libre si apetece apretar.' },
        { exerciseId: 'barbell-row',          sets: 4, repsTarget: '8-10',  restSec: 75,  notes: 'Tirón con el codo hacia atrás (no con bíceps). Si dudas, remo con mancuerna a una mano.' },
        { exerciseId: 'dumbbell-shoulder-press', sets: 3, repsTarget: '8-12', restSec: 75, notes: 'Si de pie molesta lumbar, hacerlo sentado en banco con respaldo.' },
        { exerciseId: 'barbell-curl',         sets: 3, repsTarget: '10-12', restSec: 60,  notes: 'Barra Z si el agarre recto molesta la muñeca.' },
        { exerciseId: 'tricep-pushdown-rope', sets: 3, repsTarget: '10-12', restSec: 60,  notes: 'Codos pegados al torso, abrir la cuerda al final.' },
        { exerciseId: 'plank',                sets: 3, repsTarget: '40-60s', restSec: 45, notes: 'Glúteo apretado, cadera neutra. Reps = segundos.' },
      ]
    },

    'full-body-b': {
      name: 'Full Body B',
      tag: 'FB-B',
      muscleGroups: ['Femoral', 'Glúteo', 'Espalda', 'Pecho', 'Hombro', 'Bíceps', 'Tríceps', 'Core'],
      exercises: [
        { exerciseId: 'romanian-deadlift',    sets: 4, repsTarget: '6-8',   restSec: 90,  notes: 'Cadera atrás, ligera flexión de rodilla, barra pegada al cuerpo. Bajar hasta sentir estiramiento isquios.' },
        { exerciseId: 'pull-up',              sets: 4, repsTarget: '6-10',  restSec: 90,  notes: 'Si no llegas a 6 a peso corporal: máquina asistida o banda. Más adelante con peso añadido.' },
        { exerciseId: 'incline-bench-dumbbell', sets: 4, repsTarget: '8-10', restSec: 75, notes: 'Banco a 30-45°. ROM completo, mancuernas casi se tocan arriba.' },
        { exerciseId: 'hip-thrust',           sets: 3, repsTarget: '10-12', restSec: 75,  notes: 'Espalda apoyada justo bajo escápulas, mentón al pecho, glúteo apretado arriba 1 segundo.' },
        { exerciseId: 'lateral-raise',        sets: 3, repsTarget: '12-15', restSec: 45,  notes: 'Subir codos (no manos). Sensación de echar agua de una jarra. Mancuernas ligeras y técnica limpia.' },
        { exerciseId: 'hammer-curl',          sets: 3, repsTarget: '10-12', restSec: 60,  notes: 'Para braquial (la zona que da grosor al brazo).' },
        { exerciseId: 'skull-crusher',        sets: 3, repsTarget: '10-12', restSec: 60,  notes: 'Press francés con barra Z. Codos fijos apuntando al techo, mover solo antebrazo.' },
        { exerciseId: 'ab-wheel',             sets: 3, repsTarget: '10-12', restSec: 45,  notes: 'Si no la dominas: crunch en polea alta arrodillado.' },
      ]
    },

    'outdoor': {
      name: 'Día Outdoor (parque)',
      tag: 'OUT',
      muscleGroups: ['Cardio', 'Espalda', 'Pecho', 'Tríceps', 'Core'],
      // Estructura: calentamiento 5-8 min (movilidad hombro/cadera + trote suave)
      //  -> cardio: correr 3 km (~20-25 min)
      //  -> circuito de fuerza x3-4 rondas (abajo)
      //  -> vuelta a la calma: caminar de regreso + estiramientos.
      // PROGRESIÓN DOMINADAS (no hace ninguna aún):
      //  1) Remo invertido ajustando ángulo (más erguido = más fácil) -> 3x10-12 limpias.
      //  2) Dead hang: colgarse 20-30s x3 si hay barra (agarre y hombro).
      //  3) Negativas: subir con salto a barbilla sobre barra, bajar lento 4-5s, 3-4 reps.
      // Si prioriza fuerza ese día, hacer la calistenia FRESCO y correr al final.
      notes: 'Sesión de parque: trote 3km + circuito calistenia x3-4 rondas. Incluye progresión hacia la primera dominada (remo invertido → dead hang → negativas).',
      exercises: [
        { exerciseId: 'inverted-row', sets: 4, repsTarget: '8-12',  restSec: 75, notes: 'Barras a la altura de la cintura. Cuerpo recto y rígido, llevar el pecho a la barra. Más erguido = más fácil; más horizontal = más difícil. Base para la dominada.' },
        { exerciseId: 'dips-chest',   sets: 3, repsTarget: '3-6',   restSec: 90, notes: 'Barras paralelas de fondos. Si no llegas a 6: negativas (subir con salto, bajar lento 4-5s). Bajar hasta hombro a la altura del codo.' },
        { exerciseId: 'push-up',      sets: 3, repsTarget: '10-15', restSec: 60, notes: 'Flexiones inclinadas con manos en la barra baja. Cuerpo recto, codos a ~45°. Cuando salgan 15 fáciles, bajar la inclinación.' },
        { exerciseId: 'l-sit',        sets: 3, repsTarget: '15-20s', restSec: 60, notes: 'Apoyo en barras bajas, brazos rectos. Empezar con rodillas flexionadas (tuck) y progresar a piernas extendidas.' },
        { exerciseId: 'dead-hang',    sets: 3, repsTarget: '20-30s', restSec: 60, notes: 'Solo si la barra de dominadas está puesta. Colgarse con brazos rectos, hombros activos. Construye agarre para la dominada.' },
        { exerciseId: 'plank',        sets: 3, repsTarget: '40-60s', restSec: 45, notes: 'Cerrar con core. Glúteo apretado, cadera neutra.' },
      ]
    },

    'rest': {
      name: 'Descanso',
      tag: 'REST',
      muscleGroups: [],
      exercises: []
    }

  }

};
