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
  { id: 'bench-press-dumbbell',   name: 'Press banca con mancuernas',     group: 'chest', pattern: 'horizontal-push', equipment: 'dumbbell' },
  { id: 'incline-bench-barbell',  name: 'Press inclinado con barra',      group: 'chest', pattern: 'incline-push', equipment: 'barbell' },
  { id: 'incline-bench-dumbbell', name: 'Press inclinado con mancuernas', group: 'chest', pattern: 'incline-push', equipment: 'dumbbell' },
  { id: 'decline-bench',          name: 'Press declinado',                group: 'chest', pattern: 'decline-push', equipment: 'barbell' },
  { id: 'chest-press-machine',    name: 'Press de pecho en máquina',      group: 'chest', pattern: 'horizontal-push', equipment: 'machine' },
  { id: 'cable-fly',              name: 'Aperturas en polea',             group: 'chest', pattern: 'isolation', equipment: 'cable' },
  { id: 'pec-deck',               name: 'Contractor (peck deck)',         group: 'chest', pattern: 'isolation', equipment: 'machine' },
  { id: 'dumbbell-fly',           name: 'Aperturas con mancuernas',       group: 'chest', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'dips-chest',             name: 'Fondos en paralelas (pecho)',    group: 'chest', pattern: 'decline-push', equipment: 'bodyweight' },
  { id: 'push-up',                name: 'Flexiones',                       group: 'chest', pattern: 'horizontal-push', equipment: 'bodyweight' },

  // ===== ESPALDA =====
  { id: 'pull-up',                name: 'Dominadas',                       group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },
  { id: 'chin-up',                name: 'Dominadas supinas',               group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },
  { id: 'lat-pulldown',           name: 'Jalón al pecho',                  group: 'back', pattern: 'vertical-pull', equipment: 'cable' },
  { id: 'lat-pulldown-neutral',   name: 'Jalón agarre neutro',             group: 'back', pattern: 'vertical-pull', equipment: 'cable' },
  { id: 'barbell-row',            name: 'Remo con barra',                  group: 'back', pattern: 'horizontal-pull', equipment: 'barbell' },
  { id: 'dumbbell-row',           name: 'Remo con mancuerna',              group: 'back', pattern: 'horizontal-pull', equipment: 'dumbbell' },
  { id: 't-bar-row',              name: 'Remo en T',                       group: 'back', pattern: 'horizontal-pull', equipment: 'machine' },
  { id: 'seated-cable-row',       name: 'Remo sentado en polea',           group: 'back', pattern: 'horizontal-pull', equipment: 'cable' },
  { id: 'machine-row',            name: 'Remo en máquina',                 group: 'back', pattern: 'horizontal-pull', equipment: 'machine' },
  { id: 'face-pull',              name: 'Face pull',                       group: 'back', pattern: 'isolation', equipment: 'cable' },
  { id: 'inverted-row',           name: 'Remo invertido',                  group: 'back', pattern: 'horizontal-pull', equipment: 'bodyweight' },
  { id: 'dead-hang',              name: 'Colgarse en barra (dead hang)',   group: 'back', pattern: 'vertical-pull', equipment: 'bodyweight' },
  { id: 'pullover',               name: 'Pullover',                        group: 'back', pattern: 'isolation', equipment: 'cable' },
  { id: 'deadlift',               name: 'Peso muerto convencional',        group: 'back', pattern: 'hinge', equipment: 'barbell' },
  { id: 'sumo-deadlift',          name: 'Peso muerto sumo',                group: 'back', pattern: 'hinge', equipment: 'barbell' },
  { id: 'trap-bar-deadlift',      name: 'Peso muerto barra hexagonal',     group: 'back', pattern: 'hinge', equipment: 'barbell' },

  // ===== HOMBRO =====
  { id: 'overhead-press',         name: 'Press militar con barra',         group: 'shoulders', pattern: 'vertical-push', equipment: 'barbell' },
  { id: 'dumbbell-shoulder-press',name: 'Press hombro con mancuernas',     group: 'shoulders', pattern: 'vertical-push', equipment: 'dumbbell' },
  { id: 'shoulder-press-machine', name: 'Press hombro en máquina',         group: 'shoulders', pattern: 'vertical-push', equipment: 'machine' },
  { id: 'lateral-raise',          name: 'Elevaciones laterales',           group: 'shoulders', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'cable-lateral',          name: 'Elevaciones laterales en polea',  group: 'shoulders', pattern: 'isolation', equipment: 'cable' },
  { id: 'rear-delt-fly',          name: 'Pájaro / deltoide posterior',     group: 'shoulders', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'reverse-pec-deck',       name: 'Pájaro en máquina',               group: 'shoulders', pattern: 'isolation', equipment: 'machine' },
  { id: 'front-raise',            name: 'Elevaciones frontales',           group: 'shoulders', pattern: 'isolation', equipment: 'dumbbell' },

  // ===== TRÍCEPS =====
  { id: 'tricep-pushdown-rope',   name: 'Tríceps polea con cuerda',        group: 'triceps', pattern: 'isolation', equipment: 'cable' },
  { id: 'tricep-pushdown-bar',    name: 'Tríceps polea con barra',         group: 'triceps', pattern: 'isolation', equipment: 'cable' },
  { id: 'overhead-tricep',        name: 'Tríceps por encima de cabeza',    group: 'triceps', pattern: 'isolation', equipment: 'cable' },
  { id: 'skull-crusher',          name: 'Press francés',                   group: 'triceps', pattern: 'isolation', equipment: 'barbell' },
  { id: 'dips-tricep',            name: 'Fondos para tríceps',             group: 'triceps', pattern: 'vertical-push', equipment: 'bodyweight' },
  { id: 'close-grip-bench',       name: 'Press banca agarre cerrado',      group: 'triceps', pattern: 'horizontal-push', equipment: 'barbell' },

  // ===== BÍCEPS =====
  { id: 'barbell-curl',           name: 'Curl bíceps con barra',           group: 'biceps', pattern: 'isolation', equipment: 'barbell' },
  { id: 'dumbbell-curl',          name: 'Curl bíceps con mancuernas',      group: 'biceps', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'hammer-curl',            name: 'Curl martillo',                   group: 'biceps', pattern: 'isolation', equipment: 'dumbbell' },
  { id: 'preacher-curl',          name: 'Curl en banco Scott',             group: 'biceps', pattern: 'isolation', equipment: 'barbell' },
  { id: 'cable-curl',             name: 'Curl en polea',                   group: 'biceps', pattern: 'isolation', equipment: 'cable' },
  { id: 'incline-curl',           name: 'Curl inclinado mancuernas',       group: 'biceps', pattern: 'isolation', equipment: 'dumbbell' },

  // ===== CUÁDRICEPS =====
  { id: 'back-squat',             name: 'Sentadilla trasera',              group: 'quads', pattern: 'squat', equipment: 'barbell' },
  { id: 'front-squat',            name: 'Sentadilla frontal',              group: 'quads', pattern: 'squat', equipment: 'barbell' },
  { id: 'leg-press',              name: 'Prensa',                          group: 'quads', pattern: 'squat', equipment: 'machine' },
  { id: 'hack-squat',             name: 'Hack squat',                      group: 'quads', pattern: 'squat', equipment: 'machine' },
  { id: 'leg-extension',          name: 'Extensión de cuádriceps',         group: 'quads', pattern: 'isolation', equipment: 'machine' },
  { id: 'bulgarian-split',        name: 'Búlgaras',                        group: 'quads', pattern: 'lunge', equipment: 'dumbbell' },
  { id: 'walking-lunge',          name: 'Zancadas caminando',              group: 'quads', pattern: 'lunge', equipment: 'dumbbell' },
  { id: 'air-squat',              name: 'Sentadilla a peso corporal',      group: 'quads', pattern: 'squat', equipment: 'bodyweight' },

  // ===== FEMORAL =====
  { id: 'romanian-deadlift',      name: 'Peso muerto rumano',              group: 'hamstrings', pattern: 'hinge', equipment: 'barbell' },
  { id: 'stiff-leg-deadlift',     name: 'Peso muerto piernas rígidas',     group: 'hamstrings', pattern: 'hinge', equipment: 'barbell' },
  { id: 'leg-curl-seated',        name: 'Curl femoral sentado',            group: 'hamstrings', pattern: 'isolation', equipment: 'machine' },
  { id: 'leg-curl-lying',         name: 'Curl femoral tumbado',            group: 'hamstrings', pattern: 'isolation', equipment: 'machine' },
  { id: 'good-morning',           name: 'Good morning',                    group: 'hamstrings', pattern: 'hinge', equipment: 'barbell' },

  // ===== GLÚTEO =====
  { id: 'hip-thrust',             name: 'Hip thrust',                      group: 'glutes', pattern: 'hinge', equipment: 'barbell' },
  { id: 'glute-bridge',           name: 'Puente de glúteo',                group: 'glutes', pattern: 'hinge', equipment: 'barbell' },
  { id: 'cable-kickback',         name: 'Patada de glúteo en polea',       group: 'glutes', pattern: 'isolation', equipment: 'cable' },
  { id: 'glute-machine',          name: 'Glúteo en máquina',               group: 'glutes', pattern: 'isolation', equipment: 'machine' },

  // ===== GEMELO =====
  { id: 'standing-calf',          name: 'Gemelo de pie',                   group: 'calves', pattern: 'isolation', equipment: 'machine' },
  { id: 'seated-calf',            name: 'Gemelo sentado',                  group: 'calves', pattern: 'isolation', equipment: 'machine' },
  { id: 'leg-press-calf',         name: 'Gemelo en prensa',                group: 'calves', pattern: 'isolation', equipment: 'machine' },

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
