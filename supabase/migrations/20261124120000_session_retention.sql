/*
  Retention for conversations (OPS-4, decided 2026-11-24): a session is deleted when its last
  activity is past its period, 30 days for calls (voice, phone: transcripts are more sensitive
  than typed text) and 12 months for text (chat, whatsapp). Until now every row was kept for
  ever, so the records of processing could not name a period (docs/SECURITY.md → Personal data).

  Last activity is ai_sessions.updated_at: the ai_messages_touch_session trigger moves it on
  every new row, so a chat still in use is never swept. Deleting a session cascades to its
  ai_messages, voice_calls and tool_confirmations (all ON DELETE CASCADE); nothing references a
  session otherwise.

  public.sweep_expired_sessions() does the delete and returns how many sessions went. Only the
  owner runs it: the pg_cron job below runs as the migration owner, and no API role has
  EXECUTE (the API never deletes by age). It is an ordinary function, not SECURITY DEFINER.

  After applying: pg_cron is already enabled on the dev project (REL-1). Check that
  `select jobname, schedule from cron.job where jobname = 'session-retention-sweep'` gives one
  row, `15 3 * * *`; if it is missing (pg_cron was off), enable pg_cron and run the last DO block
  of this file again. No generated type changes (a function nobody calls from the client).
*/

CREATE OR REPLACE FUNCTION public.sweep_expired_sessions() RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
  WITH gone AS (
    DELETE FROM public.ai_sessions
    WHERE (channel IN ('voice', 'phone') AND updated_at < now() - interval '30 days')
       OR (channel IN ('chat', 'whatsapp') AND updated_at < now() - interval '12 months')
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;

REVOKE ALL ON FUNCTION public.sweep_expired_sessions() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sweep_expired_sessions() IS
  'OPS-4 retention: deletes sessions whose last activity (updated_at) is past 30 days (voice, phone) or 12 months (chat, whatsapp), with their messages, calls and confirmations; returns the count. Run daily by the session-retention-sweep cron job; no API role may execute it.';

-- Guarded like voice-calls-sweep (20261028100200_voice_calls.sql): a local stack without
-- pg_cron applies the migration and skips the schedule with a notice. Re-run this block after
-- enabling pg_cron on a project; running it twice is harmless.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; skipping the session-retention-sweep schedule.';
    RETURN;
  END IF;
  PERFORM cron.unschedule('session-retention-sweep')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'session-retention-sweep');
  PERFORM cron.schedule(
    'session-retention-sweep',
    '15 3 * * *',
    $sweep$SELECT public.sweep_expired_sessions()$sweep$
  );
END $$;
