# ONIX — App personal de entrenamiento

PWA personal de tracking de entrenamiento. Funciona en el móvil, datos locales, sin backend.

## Flujo de trabajo: dos chats

El proyecto se trabaja en **dos chats paralelos** dentro del mismo proyecto FITNESS de Claude. Comparten carpeta, memoria e instrucciones — pero cada uno tiene un foco distinto:

### Chat "App" (este o el actual)

- **Foco:** código, diseño visual, UX, nuevas funcionalidades, bugs.
- **Archivos que toca:** `index.html`, `sw.js`, `manifest.webmanifest`, `icon.svg`, este `README.md`.
- **NO toca:** archivos dentro de `data/`.

### Chat "Personal Trainer"

- **Foco:** programación deportiva — diseño de rutinas, planificación semanal/mensual, progresión, consejos técnicos, ajustes en función de cómo avanza Adrián.
- **Archivos que toca:** todo lo que vive en `data/`.
  - `data/routines.js` — plan vigente, calendario semanal, rutinas con ejercicios/series/reps/descansos.
  - `data/exercises.js` — banco de ejercicios (catálogo maestro). Puede añadir/editar ejercicios que falten.
- **NO toca:** `index.html` ni nada del código de la app.

**Ojo con `data/`:** la fuente de verdad del programa (rutinas, plan, calendario y objetivos)
es Supabase, y es distinta para cada usuario. La app ya **ni carga `data/routines.js`**: era el
plan de Adrián (con su peso, su % de grasa y sus notas) y, aunque el arranque lo sobrescribía
siempre y nunca llegaba a pintarse, se servía a cualquiera que abriese la app. El archivo sigue
en el repo como referencia del chat Personal Trainer, pero no viaja al navegador. De
`data/exercises.js` sí se usa el catálogo como respaldo mientras no hay sincronización.

## De dónde salen los entrenos de un usuario nuevo

Quien se registra no arranca vacío: hay **siete plantillas de sistema** en Supabase
(`routine_templates` + `routine_template_exercises`, de solo lectura para todo el mundo) y el
alta le **copia** las que le tocan a sus propias tablas, según lo que marque en la bienvenida:

| Material | 2-3 días/sem | 4+ días/sem |
|---|---|---|
| Gimnasio | INTRO A + INTRO B alternadas | TORSO + PIERNA alternadas |
| Casa (mancuernas) | CASA, alternada con descanso | CASA + BODY alternadas |
| Exterior / sin material | BODY | BODY + CARDIO |

Lo hace `public.seed_starter_plan()`, que llaman dos triggers: `handle_new_user` (al crear la
cuenta, con el supuesto seguro BODY/3 días por si abandona la bienvenida) y `on_profile_onboarded`
(al terminarla, ya con el material y los días de verdad). En cuanto el Coach monta el plan
(`first_session_done`), la siembra deja de tocar nada. Todo vive en
`supabase/migrations/`, que es de donde hay que editarlo — no a mano en el panel de Supabase.

## Estructura de archivos

```
FITNESS/
├── index.html              # App (UI + lógica)
├── manifest.webmanifest    # Config PWA
├── sw.js                   # Service worker (offline)
├── icon.svg                # Icono de la app
├── README.md               # Este archivo
├── data/
│   ├── routines.js         # Plan de referencia del chat Personal Trainer (NO se carga)
│   └── exercises.js        # Banco de ejercicios (chat Personal Trainer)
└── supabase/
    └── migrations/         # Esquema, triggers y plantillas de rutinas iniciales
```

## Cómo añadir/cambiar una rutina

Editar `data/routines.js`. La estructura está documentada en el propio archivo. Cada ejercicio referencia un `exerciseId` que debe existir en `data/exercises.js`. Si el ejercicio que quiere usar el trainer no existe, primero se añade a `exercises.js` y luego se referencia desde `routines.js`.

## Cómo abrir la app

Abrir `index.html` en navegador. En móvil, "Añadir a pantalla de inicio" para que quede como app nativa. Funciona offline después de la primera carga.

## Memoria persistente entre chats

La memoria del proyecto FITNESS (perfil de Adrián, decisiones de diseño, contexto) se comparte automáticamente entre los dos chats. No hay que repetir nada al abrir el chat de Personal Trainer.
