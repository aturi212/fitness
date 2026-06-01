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

La app lee automáticamente de `data/`, así que los cambios del chat de entrenamientos aparecen al recargar.

## Estructura de archivos

```
FITNESS/
├── index.html              # App (UI + lógica)
├── manifest.webmanifest    # Config PWA
├── sw.js                   # Service worker (offline)
├── icon.svg                # Icono de la app
├── README.md               # Este archivo
└── data/
    ├── routines.js         # Plan, calendario y rutinas (chat Personal Trainer)
    └── exercises.js        # Banco de ejercicios (chat Personal Trainer)
```

## Cómo añadir/cambiar una rutina

Editar `data/routines.js`. La estructura está documentada en el propio archivo. Cada ejercicio referencia un `exerciseId` que debe existir en `data/exercises.js`. Si el ejercicio que quiere usar el trainer no existe, primero se añade a `exercises.js` y luego se referencia desde `routines.js`.

## Cómo abrir la app

Abrir `index.html` en navegador. En móvil, "Añadir a pantalla de inicio" para que quede como app nativa. Funciona offline después de la primera carga.

## Memoria persistente entre chats

La memoria del proyecto FITNESS (perfil de Adrián, decisiones de diseño, contexto) se comparte automáticamente entre los dos chats. No hay que repetir nada al abrir el chat de Personal Trainer.
