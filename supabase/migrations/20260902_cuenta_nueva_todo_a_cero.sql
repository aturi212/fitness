-- Cuenta nueva = todo a cero.
--
-- La versión desplegada de handle_new_user (añadida por el panel, nunca
-- commiteada) llamaba a seed_starter_plan(): copiaba rutinas de
-- routine_templates al usuario recién creado y le rellenaba el calendario
-- semanal. Resultado: el usuario nuevo abría la app con un entrenamiento
-- asignado y el coach le hablaba de «su plan» antes de la primera sesión.
--
-- Ahora el alta deja la cuenta vacía: rutina 'Descanso', plan activo con
-- calendario en blanco y perfil. El plan de verdad sale de la primera sesión
-- con el coach o de crearlo a mano. Las tablas routine_templates y
-- routine_template_exercises SIGUEN existiendo como plantillas disponibles;
-- lo que desaparece es que se asignen solas.

drop function if exists public.seed_starter_plan(uuid);

-- Misma definición que 20260826 (comprobar invitación, cuenta montada en
-- blanco, consumo solo si el correo ya viene confirmado), sin el sembrado.
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
  -- trigger de confirmación no llega a dispararse nunca: hay que gastarlo aquí.
  if new.email_confirmed_at is not null then
    perform public.consume_invite(new.id, v_code);
  end if;

  return new;
end;
$$;
