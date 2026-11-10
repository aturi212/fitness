-- ============================================================
-- Plan del usuario (Gratis / Básico / Premium)
-- ------------------------------------------------------------
-- Decide el tope diario de comidas con IA (foto + texto, un solo
-- contador): free 3 · basic 8 · premium 40 (cortafuegos, no se anuncia).
-- Ver supabase/functions/_shared/ai_usage.ts (MEALS_PER_DAY) y
-- onix-hq/negocio/OXIA_tope_plan_gratis.md.
--
-- Aditiva: NULL = Gratis. Las funciones ya funcionan SIN esta columna
-- (todos Gratis); con ella se puede subir a alguien de plan.
-- El usuario no puede cambiarse el plan: solo service_role.
-- ============================================================

alter table public.profiles
  add column if not exists plan text
  check (plan is null or plan in ('free', 'basic', 'premium'));

comment on column public.profiles.plan is
  'Plan de pago: free | basic | premium. NULL = free. Lo escribe solo el servidor.';

-- Que nadie se suba el plan desde la app. Un REVOKE de columna no basta
-- (el permiso de tabla lo cubre), así que lo para un trigger: solo
-- service_role (o SQL directo, sin rol de la API) puede tocar `plan`.
create or replace function public.profiles_plan_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and new.plan is distinct from (case when tg_op = 'UPDATE' then old.plan else null end) then
    raise exception 'plan solo lo cambia el servidor';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_plan_guard on public.profiles;
create trigger profiles_plan_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_plan_guard();
