-- ============================================================
-- Búsquedas web del Coach en ai_usage
-- ------------------------------------------------------------
-- kind 'coach_search': una fila por ronda del Coach que usó la herramienta de
-- servidor web_search; web_searches = cuántas búsquedas (10 $ / 1.000).
-- No cuentan para los topes (ni por minuto ni en el global del día): no son
-- llamadas a la API, van dentro de una ronda que ya se contó.
-- ============================================================

alter table public.ai_usage add column if not exists web_searches integer not null default 0;

alter table public.ai_usage drop constraint if exists ai_usage_kind_check;
alter table public.ai_usage add constraint ai_usage_kind_check
  check (kind in ('coach', 'coach_round', 'photo', 'text', 'nutritionist', 'coach_search'));

create or replace function public.ai_usage_counts(p_user uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with d as (
    select (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid') as dia
  )
  select json_build_object(
    'minute',       count(*) filter (where u.user_id = p_user and u.kind not in ('coach_round', 'coach_search')
                                       and u.created_at > now() - interval '1 minute'),
    'coach',        count(*) filter (where u.user_id = p_user and u.kind = 'coach' and u.created_at >= d.dia),
    'photo',        count(*) filter (where u.user_id = p_user and u.kind = 'photo' and u.created_at >= d.dia),
    'nutritionist', count(*) filter (where u.user_id = p_user and u.kind = 'nutritionist' and u.created_at >= d.dia),
    'global',       count(*) filter (where u.kind <> 'coach_search' and u.created_at >= d.dia)
  )
  from d left join public.ai_usage u on u.created_at >= least(d.dia, now() - interval '1 minute')
  group by d.dia;
$$;

revoke execute on function public.ai_usage_counts(uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_counts(uuid) to service_role;
