-- OPS-4 (20261124120000_session_retention.sql): public.sweep_expired_sessions() deletes the
-- sessions whose last activity (updated_at) is past the retention period, 30 days for calls
-- (voice, phone) and 12 months for text (chat, whatsapp), with everything that hangs off them;
-- younger sessions stay. No API role may run it; the daily job exists wherever pg_cron is
-- installed.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- Fixtures, as the database owner. Replica mode turns the triggers off, so the inserted
-- messages do not move updated_at back to now() and the back-dates hold.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000040a1', 'ret@test.local');
set local session_replication_role = replica;
insert into public.ai_sessions (id, user_id, channel, updated_at)
select s.id::uuid, u.id, s.channel, now() - s.age
from public.users u,
  (values
    ('00000000-0000-0000-0000-0000000040b1', 'voice', interval '31 days'),
    ('00000000-0000-0000-0000-0000000040b2', 'voice', interval '29 days'),
    ('00000000-0000-0000-0000-0000000040b3', 'phone', interval '31 days'),
    ('00000000-0000-0000-0000-0000000040b4', 'chat', interval '13 months'),
    ('00000000-0000-0000-0000-0000000040b5', 'chat', interval '11 months'),
    ('00000000-0000-0000-0000-0000000040b6', 'whatsapp', interval '13 months')
  ) as s(id, channel, age)
where u.auth_user_id = '00000000-0000-0000-0000-0000000040a1';
insert into public.ai_messages (id, session_id, role, turn_kind, content)
values
  ('00000000-0000-0000-0000-0000000040c1', '00000000-0000-0000-0000-0000000040b1', 'user', 'user', '[{"type":"text","text":"x"}]'),
  ('00000000-0000-0000-0000-0000000040c2', '00000000-0000-0000-0000-0000000040b2', 'user', 'user', '[{"type":"text","text":"x"}]');
insert into public.voice_calls (session_id, user_id, call_token_hash, access_token, expires_at)
select '00000000-0000-0000-0000-0000000040b1', u.id, 'ret-hash', 'jwt', now() + interval '10 minutes'
from public.users u where u.auth_user_id = '00000000-0000-0000-0000-0000000040a1';
insert into public.tool_confirmations (session_id, user_id, tool, input_hash, summary, expires_at)
select '00000000-0000-0000-0000-0000000040b1', u.id, 'flag_mail', 'h', 's', now() + interval '5 minutes'
from public.users u where u.auth_user_id = '00000000-0000-0000-0000-0000000040a1';
set local session_replication_role = origin;

-- No API role may run the sweep (asserted by privilege: calling it as them crashes the local
-- image instead of raising 42501, DB-1).
select ok(not has_function_privilege('anon', 'public.sweep_expired_sessions()', 'execute'),
  'OPS-4: anon cannot run the sweep');
select ok(not has_function_privilege('authenticated', 'public.sweep_expired_sessions()', 'execute'),
  'OPS-4: a signed-in user cannot run the sweep');
select ok(not has_function_privilege('service_role', 'public.sweep_expired_sessions()', 'execute'),
  'OPS-4: the service role cannot run the sweep');

-- The sweep, as the owner (what the cron job runs as).
select is(public.sweep_expired_sessions(), 4,
  'OPS-4: the sweep deletes the four sessions past their period and says so');

select is((select count(*)::int from public.ai_sessions where id = '00000000-0000-0000-0000-0000000040b1'), 0,
  'OPS-4: a call last active 31 days ago is gone');
select is((select count(*)::int from public.ai_messages where session_id = '00000000-0000-0000-0000-0000000040b1'), 0,
  'OPS-4: its transcript is gone with it');
select is((select count(*)::int from public.voice_calls where call_token_hash = 'ret-hash'), 0,
  'OPS-4: its call row is gone with it');
select is((select count(*)::int from public.tool_confirmations where session_id = '00000000-0000-0000-0000-0000000040b1'), 0,
  'OPS-4: its confirmations are gone with it');
select is((select count(*)::int from public.ai_sessions where id = '00000000-0000-0000-0000-0000000040b3'), 0,
  'OPS-4: a phone call last active 31 days ago is gone');
select is((select count(*)::int from public.ai_sessions where id = '00000000-0000-0000-0000-0000000040b4'), 0,
  'OPS-4: a chat last active 13 months ago is gone');
select is((select count(*)::int from public.ai_sessions where id = '00000000-0000-0000-0000-0000000040b6'), 0,
  'OPS-4: a WhatsApp conversation last active 13 months ago is gone');
select is((select count(*)::int from public.ai_messages where session_id = '00000000-0000-0000-0000-0000000040b2'), 1,
  'OPS-4: a call last active 29 days ago stays, with its transcript');
select is((select count(*)::int from public.ai_sessions where id = '00000000-0000-0000-0000-0000000040b5'), 1,
  'OPS-4: a chat last active 11 months ago stays');

select is(public.sweep_expired_sessions(), 0, 'OPS-4: a second run finds nothing more');

-- The schedule: checked here wherever pg_cron is installed (projects), skipped on the local stack.
create function pg_temp.sweep_job_check() returns text language plpgsql as $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return skip('pg_cron is not installed here; the job is checked after applying to a project', 1);
  end if;
  return is((select count(*)::int from cron.job where jobname = 'session-retention-sweep' and schedule = '15 3 * * *'), 1,
    'OPS-4: the session-retention-sweep job runs daily at 03:15');
end $$;
select pg_temp.sweep_job_check();

select * from finish();
rollback;
