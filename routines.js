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
  // Definidos con Adrián el 2026-05-18.
  // Perfil: 1,79 m / 89 kg. Intermedio. Sin lesiones.
  // Quiere fuerza + masa magra + definición abdominal + capacidad
  // aeróbica + flexibilidad. Estética: cuadraditos visibles sin
  // estar excesivamente "mazado".
  goals: {

    shortTerm: {
      horizon: '8-12 semanas',
      deadline: '2026-08-10',
      targets: [
        { metric: 'Peso corporal',     target: '84-85 kg',  notes: 'Bajada controlada ~0,4 kg/sem, todo grasa' },
        { metric: 'Frecuencia gym',    target: '3 días/sem consolidados', notes: 'Sin saltarse ninguno' },
        { metric: 'Pasos diarios',     target: '8-10k',     notes: 'Media semanal, no obsesión diaria' },
        { metric: 'Técnica básicos',   target: 'Sólida',    notes: 'Sentadilla, press banca, remo, peso muerto rumano, dominada' },
      ]
    },

    longTerm: {
      horizon: '6-12 meses',
      deadline: '2027-05-18',
      targets: [
        { metric: 'Peso corporal',     target: '80-82 kg',          notes: 'Con abdomen marcado (~12-14% grasa)' },
        { metric: 'Sentadilla',        target: '1,2 x peso (~95 kg)', notes: 'PR de fuerza relativa' },
        { metric: 'Press banca',       target: '1,0 x peso (~80 kg)', notes: 'PR de fuerza relativa' },
        { metric: 'Peso muerto rumano',target: '1,5 x peso (~120 kg)', notes: 'PR de fuerza relativa' },
        { metric: 'Dominadas',         target: '8-10 estrictas',    notes: 'Sin asistencia, ROM completo' },
        { metric: 'Capacidad aeróbica',target: '5k corriendo cómodo', notes: 'O equivalente' },
        { metric: 'Movilidad',         target: 'Hombro/cadera/tobillo sin restricciones', notes: 'Hábito de movilidad consolidado' },
      ]
    }

  },

  // ===== PLAN MACRO (hoy → parón de septiembre) =====
  // 15 semanas en bloques de 4. Cada bloque sube exigencia.
  plan: {
    name: 'Plan Mayo - Septiembre 2026',
    startDate: '2026-05-18',
    endDate: '2026-09-01',
    notes: 'Adrián tendrá un parón en septiembre. Objetivo: aprovechar al máximo estas 15 semanas con progresión gradual antes del descanso.',
    blocks: [
      {
        id: 'block-1-adaptacion',
        name: 'Bloque 1 — Adaptación',
        startDate: '2026-05-18',
        endDate: '2026-06-14',
        weeks: 4,
        scheme: 'Full Body 2 días/sem + 1 día outdoor opcional',
        focus: 'Crear hábito, afinar técnica en básicos, instaurar doble progresión, llegar a 8-10k pasos diarios de media.'
      },
      {
        id: 'block-2-consolidacion',
        name: 'Bloque 2 — Consolidación',
        startDate: '2026-06-15',
        endDate: '2026-07-12',
        weeks: 4,
        scheme: 'Full Body 3 días/sem (A / B / C)',
        focus: 'Subir frecuencia. Añadir un tercer día de pesas. Mantener déficit ligero. Hito: 86-87 kg.'
      },
      {
        id: 'block-3-intensificacion',
        name: 'Bloque 3 — Intensificación',
        startDate: '2026-07-13',
        endDate: '2026-08-09',
        weeks: 4,
        scheme: 'Upper / Lower / Full Body — 3-4 días/sem',
        focus: 'Más volumen e intensidad. Especializar empuje/tirón. Continuar pérdida de grasa hacia 84-85 kg.'
      },
      {
        id: 'block-4-pico-deload',
        name: 'Bloque 4 — Pico + Deload',
        startDate: '2026-08-10',
        endDate: '2026-09-01',
        weeks: 3,
        scheme: 'Semanas 1-2 pico (test de PRs), semana 3 deload',
        focus: 'Buscar PRs en básicos antes del parón. Última semana, descarga (50-60% volumen). Llegar al parón sin fatiga acumulada.'
      }
    ]
  },

  // ===== BLOQUE VIGENTE =====
  currentPlan: {
    name: 'Bloque 1 — Adaptación Full Body',
    startDate: '2026-05-18',
    endDate: '2026-06-14',
    status: 'active',
    notes: '2 días de Full Body (A y B) + 1 día opcional outdoor (cardio suave + calistenia). Doble progresión: empezar en el rango bajo de reps, subir reps semana a semana, y solo subir peso al alcanzar techo del rango.'
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
        { exerciseId: 'bench-press-barbell',  sets: 4, repsTarget: '6-8',   restSec: 90,  notes: 'Dejar 1-2 reps en recámara. Pies firmes, escápulas retraídas.' },
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
