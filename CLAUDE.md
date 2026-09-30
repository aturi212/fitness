# ONIX / fitness — notas para Claude

App de entrenamiento y nutrición. PWA de un solo fichero (`index.html`) servida
por GitHub Pages en https://aturi212.github.io/fitness/, con Supabase detrás
(proyecto `Fitness`, ref `rffzgrpoffosqfkqutqq`, región eu-central-1).

## Estructura

- `index.html` — la app entera (HTML + CSS + JS en un fichero).
- `sw.js` — service worker. **Subir `CACHE` (`onix-vNN`) en cada cambio de
  `index.html`**, o el móvil sigue sirviendo el shell viejo.
- `manifest.webmanifest`, `icon-*` — PWA.
- `data/` — catálogo de ejercicios.
- `supabase/functions/` — edge functions (`chat`, `nutrition`).

## Edge functions: la regla

**Las edge functions se despliegan SIEMPRE desde el repo, nunca a mano.**

El código vivo de `chat` y `nutrition` está en `supabase/functions/<nombre>/index.ts`
(`chat` además importa `chat/coach.ts`: herramientas, prompt fijo y lectura del
stream; y las dos, `_shared/ai_usage.ts`).
Nada de editar la función en el panel de Supabase ni de desplegar un fichero
suelto: se cambia aquí, se commitea, y se despliega desde esta copia. Si alguien
toca la función por el panel, el repo deja de ser la verdad y el siguiente
despliegue desde el repo se lleva ese cambio por delante.

Antes de tocar una función, comprobar que la versión desplegada coincide con lo
que hay en el repo; si no coincide, bajar primero lo desplegado y commitearlo.

Desplegar:

```
supabase functions deploy chat --project-ref rffzgrpoffosqfkqutqq
supabase functions deploy nutrition --project-ref rffzgrpoffosqfkqutqq
```

Las dos van con `verify_jwt = false`: validan el JWT del usuario ellas mismas
con `getUser()` y devuelven 401 si no hay sesión.

## Secretos

Nada de claves en el código: todo entra por `Deno.env.get(...)`. El repo es
público, así que esto no es una preferencia de estilo.

| Secret | Para qué | Valor esperado |
|---|---|---|
| `ANTHROPIC_API_KEY` | las dos funciones | la clave de la cuenta |
| `CHAT_MODEL` | modelo del Coach (`chat`) | `claude-sonnet-5-5` |
| `CHAT_EFFORT` | esfuerzo del Coach (opcional) | sin poner: `medium` en Sonnet 5.x |
| `NUTRITION_MODEL` | modelo de análisis de comida (`nutrition`) | `claude-haiku-4-5` |

Ojo con los *defaults* del código: si `CHAT_MODEL` no existe, `chat` cae en
`claude-sonnet-5-5`. El secret tiene que estar puesto de verdad, no darse por
hecho: `ai_usage.model` dice con qué modelo se ha hecho cada llamada.

Sonnet 5.5 piensa siempre (no se puede apagar con `disabled`) y devuelve los
bloques de razonamiento vacíos pero firmados: se reenvían tal cual dentro del
bucle de herramientas. No editar mensajes ya enviados en ese bucle (invalida
caché y razonamiento): el punto de caché de la conversación es el automático
(`cache_control` en la raíz de la petición, ver `coach.ts`).

```
supabase secrets set CHAT_MODEL=claude-sonnet-5-5 --project-ref rffzgrpoffosqfkqutqq
supabase secrets list --project-ref rffzgrpoffosqfkqutqq
```

## Cosas que ya mordieron

- **Guardado de entrenos**: va por un *outbox* en `localStorage` con reintentos.
  Mientras quede algo sin subir se ve la barra de «sin sincronizar». No
  sustituirlo por un insert directo: se perdían entrenos sin red.
- **Macros dobles**: `goals.nutrition` puede venir como `{ training, rest }` o
  plano (formato antiguo). El formato plano tiene que seguir funcionando.
- **Fichas técnicas**: tabla `exercise_guides` (una por ejercicio, `guide`
  jsonb). La app las baja con el programa y las cachea aparte
  (`fitness_exercise_guides_v1`); el Coach las lee con `get_exercise_guide`.
  Sin ficha, la app no pinta nada.
- **Invitaciones**: el código se consume al **confirmar el correo**, no al
  crear la cuenta. Un alta que no llega a confirmarse no gasta el código.
