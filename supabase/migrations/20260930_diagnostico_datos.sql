-- ============================================================
-- diagnostico_datos(): una fila por problema de datos, de TODOS los usuarios
-- ------------------------------------------------------------
-- Lo que le pasó a Julia (y a otros) no debería volver a colarse en silencio.
-- Claude la ejecuta en cada revisión:  select * from public.diagnostico_datos();
-- Solo la puede ejecutar el service role (lee auth.users y datos de todos).
-- «Hoy» es el día de Madrid. Las reglas son las mismas que aplican la app y
-- el Coach (supabase/functions/chat: estadoPlan, validaRutina, validaPlan).
-- ============================================================

create or replace function public.diagnostico_datos()
returns table (user_id uuid, email text, problema text, detalle text)
language sql
stable
security definer
set search_path = public
as $$
  with hoy as (select (now() at time zone 'Europe/Madrid')::date as d),
  planes as (
    select p.*, jsonb_array_length(coalesce(p.blocks, '[]'::jsonb)) as nb
    from public.plan p where p.status = 'active'
  ),
  bloques as (
    select p.user_id, p.id as plan_id, b.ord::int as ord, b.v->>'name' as nombre,
           (b.v->>'startDate')::date as ini, (b.v->>'endDate')::date as fin
    from planes p
    cross join lateral jsonb_array_elements(coalesce(p.blocks, '[]'::jsonb)) with ordinality as b(v, ord)
    where (b.v->>'startDate') ~ '^\d{4}-\d{2}-\d{2}$' and (b.v->>'endDate') ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  cardio_rx as (select 'carrera|correr|running|rodaje|bici|cardio|tirada|trote|nadar|nataci'::text as rx),
  justifica as (select 'repet|otra vez|segunda|tercera|de nuevo|vuelta|ronda|circuito|finisher|bis\y|calent|calma|enfri|serie|interval|fartlek|progresiv'::text as rx),
  problemas as (
    -- 1. current_block distinto del que toca por fecha
    select p.user_id, 'current_block desfasado'::text as problema,
           format('guardado «%s», por fecha toca «%s»',
                  coalesce(case jsonb_typeof(p.current_block) when 'string' then p.current_block #>> '{}'
                                else p.current_block->>'name' end, '—'), b.nombre) as detalle
    from planes p join bloques b on b.plan_id = p.id and b.user_id = p.user_id, hoy
    where hoy.d between b.ini and b.fin
      and b.nombre is distinct from (case jsonb_typeof(p.current_block) when 'string' then p.current_block #>> '{}'
                                          else p.current_block->>'name' end)

    union all
    -- 2. Plan activo caducado
    select p.user_id, 'plan caducado',
           format('«%s» terminó el %s', p.name, max(b.fin))
    from planes p join bloques b on b.plan_id = p.id and b.user_id = p.user_id, hoy
    group by p.user_id, p.id, p.name, hoy.d
    having max(b.fin) < hoy.d

    union all
    -- 3. Workouts con notas «sin marcar» completas (deberían ser series)
    select w.user_id, 'entreno con «sin marcar» completo',
           format('%s %s: %s', w.date, coalesce(w.routine_id, 'libre'), l.linea)
    from public.workouts w
    cross join lateral unnest(string_to_array(w.notes, E'\n')) as l(linea)
    cross join lateral (select regexp_match(l.linea, '^(.*) · sin marcar: (.*)$') as m) x
    where w.notes ~ ' · sin marcar: ' and x.m is not null
      and public.parse_sin_marcar(x.m[2]) is not null

    union all
    -- 4. Rutinas de cardio con ejercicios de fuerza
    select r.user_id, 'rutina de cardio con fuerza',
           format('%s: %s', r.id, string_agg(re.exercise_id, ', ' order by re.position)
                  filter (where e.log_type = 'fuerza'))
    from public.routines r
    join public.routine_exercises re on re.user_id = r.user_id and re.routine_id = r.id
    join public.exercises e on e.id = re.exercise_id, cardio_rx
    where not r.archived
    group by r.user_id, r.id, r.name, r.tag, cardio_rx.rx
    having count(*) filter (where e.log_type = 'fuerza') > 0
       and concat_ws(' ', r.tag, r.name, r.id) ~* cardio_rx.rx

    union all
    -- 5. Rutinas con ejercicios repetidos (sin nota que lo justifique)
    select re.user_id, 'rutina con ejercicios repetidos',
           format('%s: %s ×%s', re.routine_id, re.exercise_id, count(*))
    from public.routine_exercises re
    join public.routines r on r.user_id = re.user_id and r.id = re.routine_id, justifica
    where not r.archived
    group by re.user_id, re.routine_id, re.exercise_id, justifica.rx
    having count(*) filter (where coalesce(re.notes, '') !~* justifica.rx) > 1

    union all
    -- 6. Días de weekly_schedule que apuntan a rutinas inexistentes o archivadas
    select p.user_id, 'calendario apunta a rutina inexistente o archivada',
           format('día %s → %s%s', s.key, s.value #>> '{}', case when r.archived then ' (archivada)' else '' end)
    from planes p
    cross join lateral jsonb_each(coalesce(p.weekly_schedule, '{}'::jsonb)) s
    left join public.routines r on r.user_id = p.user_id and r.id = s.value #>> '{}'
    where coalesce(s.value #>> '{}', 'rest') not in ('rest', '')
      and (r.id is null or r.archived)

    union all
    -- 7a. Bloques que se solapan o dejan huecos
    select b2.user_id, case when b2.ini <= b1.fin then 'bloques solapados' else 'hueco entre bloques' end,
           format('«%s» acaba %s y «%s» empieza %s', b1.nombre, b1.fin, b2.nombre, b2.ini)
    from bloques b1 join bloques b2 on b2.plan_id = b1.plan_id and b2.user_id = b1.user_id and b2.ord = b1.ord + 1
    where b2.ini <> b1.fin + 1

    union all
    -- 7b. Bloques que no llegan a la deadline de corto plazo
    select p.user_id, 'bloques no llegan a la deadline',
           format('último bloque acaba %s, deadline %s', max(b.fin), p.goals->'shortTerm'->>'deadline')
    from planes p join bloques b on b.plan_id = p.id and b.user_id = p.user_id
    where (p.goals->'shortTerm'->>'deadline') ~ '^\d{4}-\d{2}-\d{2}$'
    group by p.user_id, p.id, p.goals
    having max(b.fin) < (p.goals->'shortTerm'->>'deadline')::date
  )
  select pr.user_id, u.email::text, pr.problema, pr.detalle
  from problemas pr left join auth.users u on u.id = pr.user_id
  order by u.email, pr.problema, pr.detalle;
$$;

revoke execute on function public.diagnostico_datos() from public, anon, authenticated;
grant execute on function public.diagnostico_datos() to service_role;
