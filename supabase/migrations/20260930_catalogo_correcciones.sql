-- ============================================================
-- Catálogo: correcciones de metadatos (fichas técnicas, 30-09-2026)
-- ------------------------------------------------------------
-- grupo/patrón/material corregidos del JSON de fichas, donde difieren.
-- Son 22: patrones vacíos que se rellenan y grupo/material mal puestos.
-- NO se pisa un patrón que ya estaba puesto: plank, ab-wheel, cable-crunch,
-- hanging-leg-raise y l-sit siguen en 'isolation' (el JSON dice 'core').
-- ============================================================

update public.exercises set pattern = 'squat' where id = 'air-squat';
update public.exercises set pattern = 'hinge' where id = 'back-extension';
update public.exercises set pattern = 'isolation' where id = 'cable-fly';
update public.exercises set pattern = 'cardio' where id = 'cardio-steady';
update public.exercises set pattern = 'core', equipment = 'bodyweight' where id = 'crunch-abdominal';
update public.exercises set pattern = 'core' where id = 'decline-crunch';
update public.exercises set pattern = 'horizontal-pull' where id = 'face-pull';
update public.exercises set muscle_group = 'hamstrings', pattern = 'isolation', equipment = 'machine' where id = 'femoral-sentado';
update public.exercises set pattern = 'hinge' where id = 'glute-bridge';
update public.exercises set pattern = 'hinge' where id = 'good-morning';
update public.exercises set pattern = 'cardio' where id = 'hiking-session';
update public.exercises set pattern = 'vertical-pull' where id = 'lat-pulldown';
update public.exercises set pattern = 'isolation' where id = 'leg-extension';
update public.exercises set pattern = 'isolation' where id = 'lying-leg-curl';
update public.exercises set pattern = 'horizontal-pull' where id = 'machine-row';
update public.exercises set pattern = 'isolation' where id = 'pec-deck';
update public.exercises set pattern = 'isolation' where id = 'seated-calf';
update public.exercises set pattern = 'core' where id = 'side-plank';
update public.exercises set pattern = 'isolation' where id = 'standing-calf-raise';
update public.exercises set pattern = 'isolation' where id = 'superman';
update public.exercises set pattern = 'isolation' where id = 'tricep-pushdown-bar';
update public.exercises set pattern = 'unilateral' where id = 'walking-lunge';
