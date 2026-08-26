-- ============================================================================
-- ONIX · Plantillas de rutinas iniciales para usuarios nuevos
-- ----------------------------------------------------------------------------
-- Objetivo: que quien acaba de registrarse abra la app y ya tenga entrenos y
-- semana montados, sin esperar a hablar con el Coach.
--
-- Cómo encaja con lo que ya había:
--   · `routines` tiene PK (id, user_id) y `user_id` NOT NULL, así que una
--     rutina "de sistema" no puede vivir en esa tabla con user_id NULL.
--     Las plantillas viven en sus propias tablas (`routine_templates` y
--     `routine_template_exercises`), con `created_by` siempre NULL y sin
--     políticas de escritura: son de solo lectura para todo el mundo.
--   · Al sembrar, la plantilla se COPIA a las tablas del usuario. A partir de
--     ahí es suya: puede editarla, y el Coach también.
--   · Las rutinas personales de Adrián (gym-a, gym-b, funk, base, outdoor…)
--     no se tocan y siguen aisladas por la política RLS `own_rows`.
-- ============================================================================


-- ── 1 · Catálogo: ejercicios que usan las plantillas pasan a ser de sistema ──
-- Cuatro de ellos los creó un usuario concreto. Mientras `created_by` apunte a
-- una persona, esa persona puede editarlos o borrarlos y dejaría las plantillas
-- colgadas. Con created_by NULL nadie los puede tocar (las políticas de UPDATE
-- y DELETE piden `created_by = auth.uid()`), y todo el mundo los sigue leyendo.
update public.exercises
   set created_by = null
 where id in ('crunch-abdominal', 'bulgarian-split-squat', 'side-plank', 'standing-calf-raise')
   and created_by is not null;

-- Remo con mancuerna: faltaba en el catálogo (lo pedía el documento de
-- plantillas como opcional). No entra en ninguna plantilla todavía, pero
-- aparece en «Cambiar ejercicio» como alternativa de espalda sin barra.
insert into public.exercises (id, name, muscle_group, pattern, equipment, log_type, created_by)
values ('dumbbell-row', 'Remo con mancuerna a una mano', 'back', 'horizontal-pull', 'dumbbell', 'fuerza', null)
on conflict (id) do nothing;


-- ── 2 · Tablas de plantillas ────────────────────────────────────────────────
create table if not exists public.routine_templates (
  id            text primary key,
  name          text not null,
  tag           text,
  muscle_groups text[] not null default '{}',
  optional      boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null default null,
  updated_at    timestamptz not null default now()
);
comment on table public.routine_templates is
  'Rutinas de sistema para usuarios nuevos. created_by siempre NULL: son de solo lectura. Se copian a routines al sembrar.';

create table if not exists public.routine_template_exercises (
  template_id    text not null references public.routine_templates(id) on delete cascade,
  position       int  not null,
  exercise_id    text not null references public.exercises(id),
  sets           int,
  reps_target    text,
  rest_sec       int,
  notes          text,
  superset_group text,
  primary key (template_id, position)
);

alter table public.routine_templates          enable row level security;
alter table public.routine_template_exercises enable row level security;

-- Solo lectura: hay política de SELECT y ninguna de INSERT/UPDATE/DELETE.
drop policy if exists templates_read    on public.routine_templates;
drop policy if exists template_ex_read  on public.routine_template_exercises;
create policy templates_read   on public.routine_templates
  for select to authenticated using (true);
create policy template_ex_read on public.routine_template_exercises
  for select to authenticated using (true);


-- ── 3 · Las siete plantillas ────────────────────────────────────────────────
insert into public.routine_templates (id, name, tag, muscle_groups, optional) values
  ('full-body-a', 'INTRO A', 'FB-A',   array['Cuádriceps','Pecho','Espalda','Hombro','Core'],            false),
  ('full-body-b', 'INTRO B', 'FB-B',   array['Femoral','Pecho','Espalda','Cuádriceps','Core'],           false),
  ('torso',       'TORSO',   'TORSO',  array['Pecho','Espalda','Hombro','Bíceps','Tríceps'],             false),
  ('pierna',      'PIERNA',  'PIERNA', array['Cuádriceps','Femoral','Glúteo','Gemelo','Core'],           false),
  ('casa',        'CASA',    'CASA',   array['Cuádriceps','Pecho','Espalda','Hombro','Glúteo','Core'],   false),
  ('body',        'BODY',    'BODY',   array['Cuádriceps','Pecho','Espalda','Glúteo','Core'],            false),
  ('cardio',      'CARDIO',  'Z2',     array['Cardio'],                                                  false)
on conflict (id) do update
  set name = excluded.name,
      tag = excluded.tag,
      muscle_groups = excluded.muscle_groups,
      optional = excluded.optional,
      updated_at = now();

-- Se reescriben enteras en cada despliegue: la fuente de verdad es este fichero.
delete from public.routine_template_exercises
 where template_id in ('full-body-a','full-body-b','torso','pierna','casa','body','cardio');

insert into public.routine_template_exercises
  (template_id, position, exercise_id, sets, reps_target, rest_sec, notes) values

  -- 1 · INTRO A — Full body gimnasio (novato)
  ('full-body-a', 1, 'back-squat',              3, '8-10',   90, 'Empieza solo con la barra; baja controlado'),
  ('full-body-a', 2, 'chest-press-machine',     3, '8-10',   90, 'Escápulas atrás; recorrido completo'),
  ('full-body-a', 3, 'machine-row',             3, '8-10',   90, 'Aprieta la espalda al final del tirón'),
  ('full-body-a', 4, 'dumbbell-shoulder-press', 2, '10-12',  60, 'Sin arquear la lumbar'),
  ('full-body-a', 5, 'plank',                   3, '30-45s', 45, 'Cadera alineada, no la dejes caer'),

  -- 2 · INTRO B — Full body gimnasio (novato)
  ('full-body-b', 1, 'romanian-deadlift',       3, '8-10',   90, 'Bisagra de cadera; espalda neutra siempre'),
  ('full-body-b', 2, 'incline-bench-dumbbell',  3, '8-10',   90, 'Banco a 30°; baja hasta notar el pecho'),
  ('full-body-b', 3, 'inverted-row',            3, '8-12',   90, 'Cuanto más horizontal, más difícil'),
  ('full-body-b', 4, 'walking-lunge',           2, '10-12',  60, 'Pasos largos, rodilla cerca del suelo'),
  ('full-body-b', 5, 'crunch-abdominal',        3, '12-15',  45, 'Sube con el abdomen, no con el cuello'),

  -- 3 · TORSO — Gimnasio 4 días (intermedio)
  ('torso', 1, 'bench-press-barbell',   4, '6-8',   120, 'Pies firmes, escápulas retraídas'),
  ('torso', 2, 'barbell-row',           4, '6-8',   120, 'Torso a ~45°, sin dar tirones'),
  ('torso', 3, 'overhead-press',        3, '8-10',   90, 'Glúteo apretado para no arquear'),
  ('torso', 4, 'lateral-raise',         3, '12-15',  60, 'Ligero, codos algo flexionados'),
  ('torso', 5, 'barbell-curl',          2, '10-12',  60, 'Codos pegados al cuerpo'),
  ('torso', 6, 'tricep-pushdown-rope',  2, '10-12',  60, 'Abre la cuerda abajo'),

  -- 4 · PIERNA — Gimnasio 4 días (intermedio)
  ('pierna', 1, 'back-squat',           4, '6-8',   120, 'Profundidad hasta paralela o más'),
  ('pierna', 2, 'romanian-deadlift',    3, '8-10',   90, 'Estira femoral, no toques el suelo'),
  ('pierna', 3, 'hip-thrust',           3, '8-10',   90, 'Pausa de 1s arriba apretando glúteo'),
  ('pierna', 4, 'leg-extension',        2, '12-15',  60, 'Controla la bajada'),
  ('pierna', 5, 'standing-calf-raise',  3, '12-15',  45, 'Pausa arriba y estiramiento abajo'),
  ('pierna', 6, 'hanging-leg-raise',    3, '10-12',  60, 'Sin balanceo; rodillas al pecho si hace falta'),

  -- 5 · CASA — Con mancuernas
  ('casa', 1, 'bulgarian-split-squat',    3, '10-12',  90, 'Pie trasero en silla o sofá'),
  ('casa', 2, 'push-up',                  3, '8-15',   90, 'Si no llegas, apoya rodillas'),
  ('casa', 3, 'inverted-row',             3, '8-12',   90, 'Bajo una mesa robusta'),
  ('casa', 4, 'dumbbell-shoulder-press',  3, '10-12',  90, 'De pie o sentado con espalda recta'),
  ('casa', 5, 'glute-bridge',             3, '12-15',  60, 'Pausa arriba'),
  ('casa', 6, 'plank',                    3, '30-45s', 45, null),

  -- 6 · BODY — Sin material (casa / exterior)
  ('body', 1, 'air-squat',      3, '15-20',        60, 'Ritmo controlado'),
  ('body', 2, 'push-up',        3, '8-15',         90, 'Escala con rodillas o inclinado'),
  ('body', 3, 'walking-lunge',  3, '10-12',        60, 'Sin peso, zancada larga'),
  ('body', 4, 'superman',       3, '12',           45, 'Pausa de 1-2s arriba'),
  ('body', 5, 'glute-bridge',   3, '15',           45, null),
  ('body', 6, 'side-plank',     3, '20-30s/lado',  45, 'Cadera alta'),

  -- 7 · CARDIO — Zona 2
  ('cardio', 1, 'cardio-steady', 1, '20-40 min', 0,
   'Ritmo de poder hablar. Apunta al acabar: tiempo, distancia y sensaciones');


-- ── 4 · Siembra: de la ficha del onboarding a la semana montada ─────────────
-- Tabla de asignación (material × días/semana):
--
--   Gimnasio           2-3 días → INTRO A + INTRO B alternadas
--                      4+ días  → TORSO + PIERNA alternadas
--   Casa (mancuernas)  2-3 días → CASA, alternada con descanso
--                      4+ días  → CASA + BODY alternadas
--   Exterior / nada    2-3 días → BODY
--                      4+ días  → BODY + CARDIO
--
-- Se puede llamar más de una vez sin romper nada: las rutinas se copian con
-- ON CONFLICT DO NOTHING (nunca pisa lo que el usuario o el Coach hayan
-- cambiado) y la semana solo se reescribe mientras `first_session_done` sea
-- false. En cuanto el Coach hace el plan de verdad, esta función no toca nada.
create or replace function public.seed_starter_plan(p_user uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_equip   text[];
  v_days    int;
  v_hecha   boolean;
  v_sitio   text;
  v_ids     text[];
  v_dows    int[];
  v_sched   jsonb := '{}'::jsonb;
  v_plan    int;
  i         int;
begin
  select coalesce(equipment, '{}'::text[]), training_days, coalesce(first_session_done, false)
    into v_equip, v_days, v_hecha
    from public.profiles
   where user_id = p_user;

  -- Sin ficha todavía (usuario recién creado): se siembra igual, con el
  -- supuesto más seguro — sin material, tres días.
  if not found then
    v_equip := '{}'::text[];
    v_days  := null;
    v_hecha := false;
  end if;

  -- El Coach ya ha montado un plan a medida: aquí no se pisa nada.
  if v_hecha then
    return '{}'::text[];
  end if;

  v_days := greatest(1, least(7, coalesce(v_days, 3)));

  -- El gimnasio manda sobre casa, y casa sobre exterior: se siembra con el
  -- material más completo que haya marcado. «deporte» a secas no da material.
  v_sitio := case
    when 'gimnasio' = any(v_equip) then 'gimnasio'
    when 'casa'     = any(v_equip) then 'casa'
    else 'exterior'
  end;

  v_ids := case
    when v_sitio = 'gimnasio' and v_days <= 3 then array['full-body-a', 'full-body-b']
    when v_sitio = 'gimnasio'                 then array['torso', 'pierna']
    when v_sitio = 'casa'     and v_days <= 3 then array['casa']
    when v_sitio = 'casa'                     then array['casa', 'body']
    when v_days <= 3                          then array['body']
    else                                           array['body', 'cardio']
  end;

  -- Días repartidos de lunes a domingo dejando descanso entre medias
  -- (0 = domingo, como los espera la app en weekly_schedule).
  v_dows := case v_days
    when 1 then array[1]
    when 2 then array[1, 4]
    when 3 then array[1, 3, 5]
    when 4 then array[1, 2, 4, 5]
    when 5 then array[1, 2, 3, 5, 6]
    when 6 then array[1, 2, 3, 4, 5, 6]
    else        array[1, 2, 3, 4, 5, 6, 0]
  end;

  -- Copia de las plantillas a las tablas del usuario.
  -- Si la rutina ya existe se respeta tal cual (el usuario o el Coach pueden
  -- haberla tocado) y solo se DESARCHIVA: una siembra anterior pudo haberla
  -- apartado, y si no se revive la semana apunta a una rutina que la app no
  -- pinta — que era justo el agujero que buscábamos tapar.
  insert into public.routines (user_id, id, name, tag, muscle_groups, optional, archived, updated_at)
  select p_user, t.id, t.name, t.tag, t.muscle_groups, t.optional, false, now()
    from public.routine_templates t
   where t.id = any(v_ids)
  on conflict (id, user_id) do update
    set archived = false, updated_at = now()
  where public.routines.archived;

  insert into public.routine_exercises
    (user_id, routine_id, position, exercise_id, sets, reps_target, rest_sec, notes, superset_group)
  select p_user, e.template_id, e.position, e.exercise_id,
         e.sets, e.reps_target, e.rest_sec, e.notes, e.superset_group
    from public.routine_template_exercises e
   where e.template_id = any(v_ids)
  on conflict (routine_id, position, user_id) do nothing;

  -- El día de descanso tiene que existir como rutina: el calendario lo pinta.
  insert into public.routines (user_id, id, name, tag, muscle_groups, optional, updated_at)
  values (p_user, 'rest', 'Descanso', 'REST', '{}', false, now())
  on conflict (id, user_id) do nothing;

  -- Si una siembra anterior dejó plantillas que ya no tocan (cambió el material
  -- o los días en el onboarding), se archivan — salvo que ya se hayan entrenado.
  update public.routines r
     set archived = true
   where r.user_id = p_user
     and not r.archived
     and r.id <> all(v_ids)
     and r.id in (select id from public.routine_templates)
     and not exists (
       select 1 from public.workouts w
        where w.user_id = p_user and w.routine_id = r.id
     );

  -- Semana: todo descanso y encima los días de entreno, rotando las rutinas
  -- en orden de lunes a domingo (3 días de gimnasio → L·A, X·B, V·A).
  for i in 0 .. 6 loop
    v_sched := v_sched || jsonb_build_object(i::text, 'rest');
  end loop;
  for i in 1 .. array_length(v_dows, 1) loop
    v_sched := v_sched || jsonb_build_object(
      v_dows[i]::text,
      v_ids[((i - 1) % array_length(v_ids, 1)) + 1]
    );
  end loop;

  select id into v_plan
    from public.plan
   where user_id = p_user and status = 'active'
   order by id desc
   limit 1;

  if v_plan is null then
    insert into public.plan (user_id, id, name, status, weekly_schedule, updated_at)
    values (p_user,
            coalesce((select max(id) + 1 from public.plan where user_id = p_user), 1),
            'Mi plan', 'active', v_sched, now());
  else
    update public.plan
       set weekly_schedule = v_sched, updated_at = now()
     where user_id = p_user and id = v_plan;
  end if;

  return v_ids;
end;
$$;

revoke all on function public.seed_starter_plan(uuid) from public, anon, authenticated;


-- ── 5 · Enganches ───────────────────────────────────────────────────────────

-- 5.a · Al crear la cuenta. Todavía no hay onboarding, así que cae en el
--       supuesto seguro (BODY, tres días): quien abandone la bienvenida a
--       medias tampoco se encuentra la app vacía.
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

  -- Plantillas + semana. Se vuelve a sembrar al terminar la bienvenida, ya con
  -- el material y los días de verdad (trigger on_profile_onboarded).
  -- Si la siembra fallara, el alta sigue adelante: mejor una app vacía que no
  -- poder registrarse. El aviso queda en los logs de Postgres.
  begin
    perform public.seed_starter_plan(new.id);
  exception when others then
    raise warning 'seed_starter_plan falló para % : %', new.id, sqlerrm;
  end;

  if new.email_confirmed_at is not null then
    perform public.consume_invite(new.id, v_code);
  end if;

  return new;
end;
$$;

-- 5.b · Al terminar la bienvenida. Aquí ya hay material y días/semana, así que
--       se resiembra con la plantilla que de verdad le toca.
create or replace function public.handle_profile_onboarded()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(new.onboarding_done, false)
     and coalesce(new.first_session_done, false) = false
     and (tg_op = 'INSERT' or coalesce(old.onboarding_done, false) = false)
  then
    -- Igual que en el alta: si la siembra falla, la ficha se guarda de todas
    -- formas — perder el onboarding entero por esto sería mucho peor.
    begin
      perform public.seed_starter_plan(new.user_id);
    exception when others then
      raise warning 'seed_starter_plan falló para % : %', new.user_id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_onboarded on public.profiles;
create trigger on_profile_onboarded
  after insert or update on public.profiles
  for each row execute function public.handle_profile_onboarded();
