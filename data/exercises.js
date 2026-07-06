/* ============================================================
   BANCO DE EJERCICIOS
   ------------------------------------------------------------
   Catálogo maestro de ejercicios disponibles. Lo usan tanto
   las rutinas (routines.js) como el botón "Cambiar ejercicio"
   del tracker (filtra por grupo muscular para sugerir
   alternativas).

   Editar este archivo: aceptable desde cualquier chat.
   Cuando añadas un ejercicio nuevo:
     - id único en kebab-case (ej: "press-banca-inclinado")
     - name en español, claro
     - group: chest|back|shoulders|biceps|triceps|quads|
              hamstrings|glutes|calves|core
     - pattern: horizontal-push|vertical-push|incline-push|
                decline-push|horizontal-pull|vertical-pull|
                squat|hinge|lunge|isolation
     - equipment: barbell|dumbbell|machine|cable|bodyweight|other
   ============================================================ */

window.EXERCISES = [
  // ===== PECHO =====
  { id: 'bench-press-barbell',    name: 'Press banca con barra',          group: 'chest', pattern: 'horizontal-push', equipment: 'barbell' },
  { id: 'incline-bench-dumbbell', name: 'Press inclinado con mancuernas', group: 'chest', pattern: 'incline-push', equipment: 'dumbbell' },
  { id: 'chest-press-machine',    name: 'Press de pecho en máquina',      group: 'chest', pattern: 'horizontal-push', equipment: 'machine' },
  { id: 'dips-chest',             name: 'Fondos en paralelas (pecho)',    group: 'chest', pattern: 'decline-push', equipment: 'bodyweight' },
  { id: 'push-up',                name: 'Flexiones',                       group: 'chest', pattern: 'horizontal-push', equipment: 'bodyweight' },

  // ===== ESPALDA =====
  { id: 'pull-up',                name: 'Dominadas',                       group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },
  { id: 'chin-up',                name: 'Dominadas supinas',               group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },
  { id: 'barbell-row',            name: 'Remo con barra',                  group: 'back', pattern: 'horizontal-pull', equipment: 'barbell' },
  { id: 'inverted-row',           name: 'Remo invertido',                  group: 'back', pattern: 'horizontal-pull', equipment: 'bodyweight' },
  { id: 'dead-hang',              name: 'Colgarse en barra (dead hang)',   group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },

  // ===== HOMBRO =====
  { id: 'overhead-press',         name: 'Press militar con barra',         group: 'shoulders', pattern: 'vertical-push', equipment: 'barbell' },
  { id: 'dumbbell-shoulder-press',name: 'Press hombro con mancuernas',     group: 'shoulders', pattern: 'vertical-push', equipment: 'dumbbell' },
  { id: 'lateral-raise',          name: 'Elevaciones laterales',           group: 'shoulders', pattern: 'isolation', equipment: 'dumbbell' },

  // ===== TRÍCEPS =====
  { id: 'tricep-pushdown-rope',   name: 'Tríceps polea con cuerda',        group: 'triceps', pattern: 'isolation', equipment: 'cable' },
  { id: 'skull-crusher',          name: 'Press francés',                   group: 'triceps', pattern: 'isolation', equipment: 'barbell' },
  { id: 'dips-tricep',            name: 'Fondos para tríceps',             group: 'triceps', pattern: 'vertical-push', equipment: 'bodyweight' },

  // ===== BÍCEPS =====
  { id: 'barbell-curl',           name: 'Curl bíceps con barra',           group: 'biceps', pattern: 'isolation', equipment: 'barbell' },
  { id: 'dumbbell-curl',          name: 'Curl bíceps con mancuernas',      group: 'biceps', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'hammer-curl',            name: 'Curl martillo',                   group: 'biceps', pattern: 'isolation', equipment: 'dumbbell' },

  // ===== CUÁDRICEPS =====
  { id: 'back-squat',             name: 'Sentadilla trasera',              group: 'quads', pattern: 'squat', equipment: 'barbell' },
  { id: 'hack-squat',             name: 'Hack squat',                      group: 'quads', pattern: 'squat', equipment: 'machine' },

  // ===== FEMORAL =====
  { id: 'romanian-deadlift',      name: 'Peso muerto rumano',              group: 'hamstrings', pattern: 'hinge', equipment: 'barbell' },

  // ===== GLÚTEO =====
  { id: 'hip-thrust',             name: 'Hip thrust',                      group: 'glutes', pattern: 'hinge', equipment: 'barbell' },

  // ===== GEMELO =====

  // ===== CORE =====
  { id: 'plank',                  name: 'Plancha',                         group: 'core', pattern: 'isolation', equipment: 'bodyweight' },
  { id: 'cable-crunch',           name: 'Crunch en polea',                 group: 'core', pattern: 'isolation', equipment: 'cable' },
  { id: 'hanging-leg-raise',      name: 'Elevación de piernas colgado',    group: 'core', pattern: 'isolation', equipment: 'bodyweight' },
  { id: 'ab-wheel',               name: 'Rueda abdominal',                 group: 'core', pattern: 'isolation', equipment: 'other' },
  { id: 'l-sit',                  name: 'L-sit (apoyo en paralelas)',      group: 'core', pattern: 'isolation', equipment: 'bodyweight' },
];

window.GROUP_LABELS = {
  chest: 'Pecho',
  back: 'Espalda',
  shoulders: 'Hombro',
  biceps: 'Bíceps',
  triceps: 'Tríceps',
  quads: 'Cuádriceps',
  hamstrings: 'Femoral',
  glutes: 'Glúteo',
  calves: 'Gemelo',
  core: 'Core'
};

window.EQUIPMENT_ICONS = {
  barbell: '🏋️',
  dumbbell: '💪',
  machine: '⚙️',
  cable: '🔗',
  bodyweight: '🧍',
  other: '·'
};
