-- ============================================================
-- Interés en más créditos de IA
-- ------------------------------------------------------------
-- Una fila cada vez que alguien toca «Quiero más» en la ventana del tope.
-- feature = lo que estaba usando cuando saltó el tope (mismos valores que
-- ai_usage.kind). Lo escribe la app con el client del usuario.
-- ============================================================

create table if not exists public.ai_upgrade_interest (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  feature    text not null check (feature in ('coach', 'photo', 'text', 'nutritionist')),
  created_at timestamptz not null default now()
);

create index if not exists ai_upgrade_interest_user_idx on public.ai_upgrade_interest (user_id, created_at desc);

alter table public.ai_upgrade_interest enable row level security;

drop policy if exists "ai_upgrade_interest: cada uno lee lo suyo" on public.ai_upgrade_interest;
create policy "ai_upgrade_interest: cada uno lee lo suyo" on public.ai_upgrade_interest
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "ai_upgrade_interest: cada uno apunta lo suyo" on public.ai_upgrade_interest;
create policy "ai_upgrade_interest: cada uno apunta lo suyo" on public.ai_upgrade_interest
  for insert to authenticated with check (user_id = (select auth.uid()));

revoke all on public.ai_upgrade_interest from anon;
revoke update, delete on public.ai_upgrade_interest from authenticated;
grant select, insert on public.ai_upgrade_interest to authenticated;
