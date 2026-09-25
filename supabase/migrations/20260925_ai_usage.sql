-- ============================================================
-- Control del uso de la IA (edge functions `chat` y `nutrition`)
-- ------------------------------------------------------------
-- Una fila por llamada a la API de Anthropic, con el usage que devuelve.
-- kind:
--   coach        primera ronda de un mensaje al Coach (= 1 mensaje)
--   coach_round  rondas siguientes del bucle de herramientas del mismo mensaje
--   photo        análisis de foto de comida
--   text         análisis de comida escrita
--   nutritionist chat del nutricionista
-- Lee cada usuario lo suyo; escribe solo el service role (las funciones).
-- ============================================================

create table if not exists public.ai_usage (
  id                    bigint generated always as identity primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  fn                    text not null check (fn in ('chat', 'nutrition')),
  kind                  text not null check (kind in ('coach', 'coach_round', 'photo', 'text', 'nutritionist')),
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  cache_read_tokens     integer not null default 0,
  cache_creation_tokens integer not null default 0,
  created_at            timestamptz not null default now()
);

create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_created_idx on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage: cada uno lee lo suyo" on public.ai_usage;
create policy "ai_usage: cada uno lee lo suyo" on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));

-- Sin políticas de insert/update/delete: solo el service role (que salta RLS).
revoke insert, update, delete on public.ai_usage from anon, authenticated;

-- Contadores para los topes, en una sola consulta. El "día" es el de Madrid.
-- Solo lo llama la función con el service role.
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
    'minute',       count(*) filter (where u.user_id = p_user and u.kind <> 'coach_round'
                                       and u.created_at > now() - interval '1 minute'),
    'coach',        count(*) filter (where u.user_id = p_user and u.kind = 'coach' and u.created_at >= d.dia),
    'photo',        count(*) filter (where u.user_id = p_user and u.kind = 'photo' and u.created_at >= d.dia),
    'nutritionist', count(*) filter (where u.user_id = p_user and u.kind = 'nutritionist' and u.created_at >= d.dia),
    'global',       count(*) filter (where u.created_at >= d.dia)
  )
  from d left join public.ai_usage u on u.created_at >= least(d.dia, now() - interval '1 minute')
  group by d.dia;
$$;

revoke execute on function public.ai_usage_counts(uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_counts(uuid) to service_role;
