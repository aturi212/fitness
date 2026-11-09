-- Recetas (Adrián, 9-nov): una receta guarda sus ingredientes con los macros
-- de cada uno y los totales de la receta entera. Al registrar comida se apunta
-- de una vez, en la ración que se elija, como una sola fila de `meals`.

create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  servings    numeric not null default 1 check (servings > 0),
  -- [{ description, kcal, protein_g, carbs_g, fat_g, fiber_g }]
  ingredients jsonb not null default '[]'::jsonb,
  -- Totales de la receta entera (no por ración)
  kcal        numeric not null default 0,
  protein_g   numeric not null default 0,
  carbs_g     numeric not null default 0,
  fat_g       numeric not null default 0,
  fiber_g     numeric not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.recipes enable row level security;

drop policy if exists own_rows on public.recipes;
create policy own_rows on public.recipes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists recipes_user_idx on public.recipes (user_id, name);

-- La comida recuerda de qué receta viene y cuántas raciones: así el día se
-- ve por recetas y se pueden desplegar sus ingredientes.
alter table public.meals
  add column if not exists recipe_id uuid references public.recipes(id) on delete set null,
  add column if not exists recipe_servings numeric;
