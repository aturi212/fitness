-- Recetas periódicas (Adrián, 10-nov): una comida periódica puede venir de una
-- receta. Cada día que se materializa en `meals` lleva recipe_id y raciones,
-- así se ve como receta (con sus ingredientes) igual que el día original.
-- Sin esta migración la app repite la receta igual, pero como comida suelta.
alter table public.recurring_meals
  add column if not exists recipe_id uuid references public.recipes(id) on delete set null,
  add column if not exists recipe_servings numeric;
