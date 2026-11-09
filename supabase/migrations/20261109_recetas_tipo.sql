-- Tipo de receta (Adrián, 9-nov): desayuno, comida, cena u otros. Ordena la
-- lista de recetas y decide cuáles se ofrecen al registrar cada tipo de comida.
alter table public.recipes
  add column if not exists category text not null default 'other'
  check (category in ('breakfast', 'lunch', 'dinner', 'other'));
