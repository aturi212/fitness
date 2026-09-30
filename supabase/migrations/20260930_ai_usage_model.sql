-- ============================================================
-- ai_usage.model: con qué modelo se hizo cada llamada
-- ------------------------------------------------------------
-- Para comparar costes por modelo (p. ej. Coach en Sonnet 4.6 vs 5.5).
-- Lo rellenan `chat` y `nutrition`. Las filas anteriores quedan a null
-- (eran claude-sonnet-4-6 en el Coach y claude-haiku-4-5 en nutrición).
-- ============================================================

alter table public.ai_usage add column if not exists model text;
