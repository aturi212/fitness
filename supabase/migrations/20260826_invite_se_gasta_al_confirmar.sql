-- El código de invitación se gasta al CONFIRMAR el correo, no al crear la cuenta.
--
-- Antes: el trigger on_auth_user_created hacía `uses = uses + 1` en el INSERT de
-- auth.users. Con «Confirm email» encendido, Supabase inserta la fila en cuanto
-- se pulsa CREAR CUENTA (sin confirmar todavía), así que un alta que se quedaba
-- a medias —correo que no llega, enlace que nadie abre, dedo equivocado— dejaba
-- el código quemado para siempre. Con 6 códigos de beta, eso es la beta entera.
--
-- Ahora: el INSERT solo COMPRUEBA que el código sirve (y tumba el alta si no).
-- El contador sube cuando email_confirmed_at pasa de null a tener valor. Si el
-- usuario nunca confirma, el código sigue libre.

-- Quién ha gastado qué. Da idempotencia: el consumo no se repite aunque el
-- trigger se dispare dos veces por el mismo usuario.
create table if not exists public.invite_redemptions (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  code        text not null,
  redeemed_at timestamptz not null default now()
);

alter table public.invite_redemptions enable row level security;
-- Nadie la lee desde el cliente: solo la tocan funciones SECURITY DEFINER.
-- Sin políticas = sin acceso por RLS, que es justo lo que queremos.

-- Gasta el código de un usuario. Silencioso si ya lo había gastado.
create or replace function public.consume_invite(p_user uuid, p_code text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ok int;
begin
  if p_code is null or p_code = '' then
    return;
  end if;

  insert into public.invite_redemptions (user_id, code)
  values (p_user, p_code)
  on conflict (user_id) do nothing;

  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    return;   -- este usuario ya lo gastó
  end if;

  update public.invites
     set uses = uses + 1
   where lower(code) = lower(p_code)
     and uses < max_uses
     and (expires_at is null or expires_at > now());

  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    -- El código se agotó entre el alta y la confirmación (otro llegó antes) o
    -- caducó por el camino. No se deja pasar: la confirmación falla.
    raise exception 'INVITE_INVALID' using errcode = 'check_violation';
  end if;
end;
$$;

-- INSERT: comprobar (no gastar) y dejar montada la cuenta.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_code text := nullif(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')), '');
begin
  if not exists (
    select 1 from public.invites
     where lower(code) = lower(coalesce(v_code, ''))
       and uses < max_uses
       and (expires_at is null or expires_at > now())
  ) then
    raise exception 'INVITE_INVALID' using errcode = 'check_violation';
  end if;

  insert into public.routines (user_id, id, name, tag, muscle_groups, optional, updated_at)
  values (new.id, 'rest', 'Descanso', 'REST', '{}', false, now())
  on conflict do nothing;

  insert into public.plan (user_id, id, name, status, weekly_schedule, updated_at)
  values (new.id, 1, 'Mi plan', 'active', '{}'::jsonb, now())
  on conflict do nothing;

  insert into public.profiles (user_id, display_name)
  values (new.id, nullif(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), ''))
  on conflict do nothing;

  -- Con «Confirm email» apagado, Supabase inserta la fila ya confirmada y el
  -- UPDATE de abajo no llega a dispararse nunca: hay que gastarlo aquí.
  if new.email_confirmed_at is not null then
    perform public.consume_invite(new.id, v_code);
  end if;

  return new;
end;
$$;

-- UPDATE: el momento en que el correo queda confirmado.
create or replace function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.consume_invite(
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')), '')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();

-- Las cuentas que ya existen y ya gastaron su código: que el contador y la
-- tabla nueva cuenten lo mismo, y que nadie las vuelva a cobrar.
insert into public.invite_redemptions (user_id, code, redeemed_at)
select u.id, u.raw_user_meta_data->>'invite_code', u.created_at
  from auth.users u
 where nullif(trim(coalesce(u.raw_user_meta_data->>'invite_code', '')), '') is not null
   and u.email_confirmed_at is not null
on conflict (user_id) do nothing;
