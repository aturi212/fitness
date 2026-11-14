-- ============================================================
-- Cupo por COMIDA GUARDADA, no por llamada (registro de comida v3)
-- ------------------------------------------------------------
-- · 'draft': cada análisis con IA (fotos + texto) o corrección. Lleva los
--   tokens reales. NO gasta cupo; solo un cortafuegos (5 × el cupo al día).
-- · 'meal' : marca sin tokens que la app manda al GUARDAR la tarjeta de
--   revisión. Es lo que cuenta para el cupo (junto a los 'photo'/'text' de
--   las versiones viejas de la app, que siguen contando por llamada).
-- 'meal' no es una llamada a la API: fuera del tope global y del de minuto.
-- ============================================================

alter table public.ai_usage drop constraint if exists ai_usage_kind_check;
alter table public.ai_usage add constraint ai_usage_kind_check
  check (kind = any (array['coach','coach_round','photo','text','nutritionist','coach_search','draft','meal']));

create or replace function public.ai_usage_counts(p_user uuid)
returns json
language sql
stable security definer
set search_path to 'public'
as $function$
  with d as (
    select (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid') as dia
  )
  select json_build_object(
    'minute',       count(*) filter (where u.user_id = p_user and u.kind not in ('coach_round', 'coach_search', 'meal')
                                       and u.created_at > now() - interval '1 minute'),
    'coach',        count(*) filter (where u.user_id = p_user and u.kind = 'coach' and u.created_at >= d.dia),
    'photo',        count(*) filter (where u.user_id = p_user and u.kind = 'photo' and u.created_at >= d.dia),
    'nutritionist', count(*) filter (where u.user_id = p_user and u.kind = 'nutritionist' and u.created_at >= d.dia),
    'draft',        count(*) filter (where u.user_id = p_user and u.kind = 'draft' and u.created_at >= d.dia),
    'global',       count(*) filter (where u.kind not in ('coach_search', 'meal') and u.created_at >= d.dia)
  )
  from d left join public.ai_usage u on u.created_at >= least(d.dia, now() - interval '1 minute')
  group by d.dia;
$function$;
