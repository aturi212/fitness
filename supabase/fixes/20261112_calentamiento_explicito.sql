-- ============================================================
-- Calentamiento explícito (v61) · corrección de datos de UNA vez
-- ------------------------------------------------------------
-- Desde la v61 la app solo pinta la serie 00 de calentamiento si la rutina
-- lo marca («cal … · trab …» en reps_target, o «Set 0» / «Calienta con…» /
-- «Serie 1 (cal)» en notes). La v60 tenía una regla automática: en press
-- banca, dominadas asistidas, polea/jalón y remo en máquina, con 5 series o
-- más, la primera era calentamiento aunque no estuviera marcado.
-- Este script marca de forma explícita las filas que hoy dependen de esa
-- regla, para que no pierdan el calentamiento.
--
-- NO es una migración: se ejecuta a mano, primero el PASO 1 (solo lee) y,
-- con el OK de Adrián sobre la lista, el PASO 2.
-- ============================================================

-- PASO 1 · Lista de filas afectadas (solo lectura)
with afectadas as (
  select re.user_id, re.routine_id, r.name as rutina, re.position,
         re.exercise_id, e.name as ejercicio, re.sets, re.reps_target, re.notes
  from public.routine_exercises re
  join public.routines r on r.user_id = re.user_id and r.id = re.routine_id
  left join public.exercises e on e.id = re.exercise_id
  where not r.archived
    and re.sets >= 5
    and concat_ws(' ', e.name, re.exercise_id) ~* '(press\s+(de\s+)?banca|bench[\s-]?press|dominadas?\s+asistidas?|assisted[\s-]?pull|polea|jal[oó]n|pulldown|remo\s+(en\s+)?m[aá]quina|machine[\s-]?row|seated[\s-]?row)'
    -- sin marca explícita de calentamiento
    and coalesce(re.reps_target, '') !~* '^\s*cal'
    and coalesce(re.notes, '') !~* '(\y(set|serie)\s*0\y|\yseries?\s*1\s*([-–y]\s*\d)?\s*(\(\s*cal|:\s*cal)|\y(calienta|calentar|calentamiento)\s+con\y|aproximaci[oó]n|\yseries?\s+(de\s+calentamiento\s+)?ligeras?\y)'
    and coalesce(re.notes, '') !~* 'sin\s+calentamiento'
)
select * from afectadas order by user_id, routine_id, position;

-- PASO 2 · Marcar el calentamiento (solo con el OK de Adrián a la lista)
-- 15 reps de calentamiento: lo que hacía hasta ahora («— × 15»).
-- begin;
-- update public.routine_exercises re
--    set reps_target = 'cal 15 · trab ' || coalesce(nullif(trim(re.reps_target), ''), '—')
--   from public.routines r, public.exercises e
--  where r.user_id = re.user_id and r.id = re.routine_id and e.id = re.exercise_id
--    and not r.archived
--    and re.sets >= 5
--    and concat_ws(' ', e.name, re.exercise_id) ~* '(press\s+(de\s+)?banca|bench[\s-]?press|dominadas?\s+asistidas?|assisted[\s-]?pull|polea|jal[oó]n|pulldown|remo\s+(en\s+)?m[aá]quina|machine[\s-]?row|seated[\s-]?row)'
--    and coalesce(re.reps_target, '') !~* '^\s*cal'
--    and coalesce(re.notes, '') !~* '(\y(set|serie)\s*0\y|\yseries?\s*1\s*([-–y]\s*\d)?\s*(\(\s*cal|:\s*cal)|\y(calienta|calentar|calentamiento)\s+con\y|aproximaci[oó]n|\yseries?\s+(de\s+calentamiento\s+)?ligeras?\y)'
--    and coalesce(re.notes, '') !~* 'sin\s+calentamiento'
--    and re.user_id = 'a032afc2-2aea-45ce-af23-1318af374ebd'   -- solo las de Adrián
-- returning re.routine_id, re.position, re.exercise_id, re.reps_target;
-- commit;
