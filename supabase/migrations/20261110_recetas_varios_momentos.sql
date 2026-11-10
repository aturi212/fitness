-- Recetas en varios momentos del día (Adrián, 10-nov): p. ej. comida y cena.
-- `categories` guarda todos los momentos marcados; `category` se queda con el
-- primero para las versiones viejas de la app. Si `categories` está vacía, la
-- app usa `category` (las recetas que ya existen siguen igual).
alter table public.recipes
  add column if not exists categories text[];
