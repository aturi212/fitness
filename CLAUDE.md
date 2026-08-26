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

El código vivo de `chat` y `nutrition` está en `supabase/functions/<nombre>/index.ts`.
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
| `CHAT_MODEL` | modelo del Coach (`chat`) | `claude-sonnet-4-6` |
| `NUTRITION_MODEL` | modelo de análisis de comida (`nutrition`) | `claude-haiku-4-5` |

Ojo con los *defaults* del código: si `CHAT_MODEL` no existe, `chat` cae en
`claude-opus-5`, que es carísimo para el uso que tiene. El secret tiene que
estar puesto de verdad, no darse por hecho.

```
supabase secrets set CHAT_MODEL=claude-sonnet-4-6 --project-ref rffzgrpoffosqfkqutqq
supabase secrets list --project-ref rffzgrpoffosqfkqutqq
```

## Cosas que ya mordieron

- **Guardado de entrenos**: va por un *outbox* en `localStorage` con reintentos.
  Mientras quede algo sin subir se ve la barra de «sin sincronizar». No
  sustituirlo por un insert directo: se perdían entrenos sin red.
- **Macros dobles**: `goals.nutrition` puede venir como `{ training, rest }` o
  plano (formato antiguo). El formato plano tiene que seguir funcionando.
- **Invitaciones**: el código se consume al **confirmar el correo**, no al
  crear la cuenta. Un alta que no llega a confirmarse no gasta el código.
