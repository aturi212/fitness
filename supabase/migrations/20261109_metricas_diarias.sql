-- Métricas diarias (Adrián, 9-nov): pasos y horas de sueño, un registro por
-- usuario y día. Se apuntan a mano desde Entreno › Métricas; más adelante,
-- desde Salud o Google Fit. El Coach podrá leerlas para macros y rutinas.

create table if not exists public.daily_metrics (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date       date not null,
  steps      integer check (steps >= 0),
  sleep_h    numeric check (sleep_h >= 0 and sleep_h <= 24),
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.daily_metrics enable row level security;

drop policy if exists own_rows on public.daily_metrics;
create policy own_rows on public.daily_metrics
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
