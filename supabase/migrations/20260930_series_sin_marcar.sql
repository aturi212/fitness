-- ============================================================
-- «sin marcar» → series reales, para TODOS los usuarios
-- ------------------------------------------------------------
-- Hasta la v33 de la app, lo escrito en un entreno sin tocar la casilla ✓ no
-- se guardaba como serie: iba a workouts.notes como
--   «<ejercicio> · sin marcar: 60×8, 60×7»            (fuerza: kg×reps)
--   «<ejercicio> · sin marcar: 5,20 km · 31 min · 150 ppm»  (cardio)
--   «<ejercicio> · sin marcar: 45s»                    (tiempo)
-- y las carreras no contaban. Esta migración pasa a workout_sets las líneas
-- COMPLETAS (todas sus series con kg y reps, segundos, o km/min en cardio) y
-- las quita de la nota. Las incompletas («30×—») se quedan como están.
-- El ejercicio se busca por nombre en exercises (si hay varios con el mismo
-- nombre, el que lleve la rutina de ese entreno; si no, el primero por id).
-- Idempotente: una línea migrada desaparece de la nota.
-- ============================================================

-- Parte las series de una línea. Devuelve un array jsonb de series
-- ({kg,reps,seconds,distance_m,hr}) o NULL si alguna está a medias.
create or replace function public.parse_sin_marcar(p_items text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  item text;
  parte text;
  m text[];
  out jsonb := '[]'::jsonb;
  s jsonb;
begin
  if p_items is null or btrim(p_items) = '' then return null; end if;
  -- Las series van separadas por «, » (coma y espacio); «1,67 km» no lleva espacio.
  foreach item in array string_to_array(p_items, ', ') loop
    item := btrim(item);
    m := regexp_match(item, '^(\d+(?:[.,]\d+)?)×(\d+)$');
    if m is not null then
      out := out || jsonb_build_array(jsonb_build_object(
        'kg', replace(m[1], ',', '.')::numeric, 'reps', m[2]::int));
      continue;
    end if;
    -- Cardio / tiempo: trozos «x km», «n min», «ns», «n ppm» unidos por « · »
    s := '{}'::jsonb;
    foreach parte in array string_to_array(item, ' · ') loop
      parte := btrim(parte);
      if parte ~ '^\d+(?:[.,]\d+)? km$' then
        s := s || jsonb_build_object('distance_m', round(replace(split_part(parte, ' ', 1), ',', '.')::numeric * 1000));
      elsif parte ~ '^\d+ min$' then
        s := s || jsonb_build_object('seconds', split_part(parte, ' ', 1)::int * 60);
      elsif parte ~ '^\d+s$' then
        s := s || jsonb_build_object('seconds', rtrim(parte, 's')::int);
      elsif parte ~ '^\d+ ppm$' then
        s := s || jsonb_build_object('hr', split_part(parte, ' ', 1)::int);
      else
        return null;          -- «30×—», «—×10» o cualquier cosa rara: a medias
      end if;
    end loop;
    if not (s ? 'distance_m' or s ? 'seconds') then return null; end if;   -- solo ppm
    out := out || jsonb_build_array(s);
  end loop;
  return out;
end;
$$;

revoke execute on function public.parse_sin_marcar(text) from public, anon, authenticated;
grant execute on function public.parse_sin_marcar(text) to service_role;

do $$
declare
  w record;
  linea text;
  m text[];
  series jsonb;
  st jsonb;
  ex_id text;
  ex_log text;
  slot int;
  idx int;
  quedan text[];
  seg_cardio int;
begin
  for w in select * from public.workouts where notes ~ ' · sin marcar: ' loop
    quedan := '{}';
    seg_cardio := 0;
    foreach linea in array string_to_array(w.notes, E'\n') loop
      m := regexp_match(linea, '^(.*) · sin marcar: (.*)$');
      series := case when m is null then null else public.parse_sin_marcar(m[2]) end;
      ex_id := null;
      if series is not null then
        select e.id, e.log_type into ex_id, ex_log
        from public.exercises e
        where lower(e.name) = lower(btrim(m[1]))
        order by exists (select 1 from public.routine_exercises re
                         where re.user_id = w.user_id and re.routine_id = w.routine_id
                           and re.exercise_id = e.id) desc, e.id
        limit 1;
      end if;
      if ex_id is null then
        quedan := quedan || linea;       -- no es «sin marcar», está a medias o no hay ejercicio
        continue;
      end if;
      select coalesce(max(slot_index), 0) into slot from public.workout_sets
        where workout_id = w.id and exercise_id = ex_id;
      if slot = 0 then
        select coalesce(max(slot_index), 0) + 1 into slot from public.workout_sets where workout_id = w.id;
      end if;
      select coalesce(max(set_index), 0) into idx from public.workout_sets
        where workout_id = w.id and exercise_id = ex_id;
      for st in select * from jsonb_array_elements(series) loop
        idx := idx + 1;
        insert into public.workout_sets
          (workout_id, user_id, exercise_id, slot_index, set_index, weight_kg, reps, seconds, distance_m, avg_hr, notes)
        values
          (w.id, w.user_id, ex_id, slot, idx,
           (st->>'kg')::numeric, (st->>'reps')::int, (st->>'seconds')::int,
           (st->>'distance_m')::numeric, (st->>'hr')::int,
           null);
        if ex_log = 'cardio' then seg_cardio := seg_cardio + coalesce((st->>'seconds')::int, 0); end if;
      end loop;
    end loop;
    update public.workouts
       set notes = nullif(array_to_string(quedan, E'\n'), ''),
           duration_sec = case when coalesce(duration_sec, 0) < 60 and seg_cardio > 0
                               then seg_cardio else duration_sec end
     where id = w.id
       and notes is distinct from nullif(array_to_string(quedan, E'\n'), '');
  end loop;
end $$;
