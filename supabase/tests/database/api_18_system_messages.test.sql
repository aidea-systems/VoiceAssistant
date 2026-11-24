-- API-18 (20261124130000_system_messages.sql): ai_messages may hold the conversation's date
-- context as a role 'system', turn_kind 'context' row, written by the service role and walked by
-- ai_session_history like any other row; every other pairing of the two columns stays refused.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000050a1', 'ctx@test.local');
insert into public.ai_sessions (id, user_id, channel)
select '00000000-0000-0000-0000-0000000050b1', u.id, 'chat'
from public.users u where u.auth_user_id = '00000000-0000-0000-0000-0000000050a1';
insert into public.ai_messages (id, session_id, role, turn_kind, content)
values ('00000000-0000-0000-0000-0000000050c1', '00000000-0000-0000-0000-0000000050b1', 'user', 'user',
        '[{"type":"text","text":"Bok"}]');

set local role service_role;
select lives_ok(
  $$ insert into public.ai_messages (id, session_id, role, turn_kind, content, parent_id)
     values ('00000000-0000-0000-0000-0000000050c2', '00000000-0000-0000-0000-0000000050b1', 'system', 'context',
             '[{"type":"text","text":"Danas je utorak, 24. studenoga 2026."}]', '00000000-0000-0000-0000-0000000050c1') $$,
  'API-18: the service role stores a date context as a system row');
select throws_ok(
  $$ insert into public.ai_messages (session_id, role, turn_kind, content)
     values ('00000000-0000-0000-0000-0000000050b1', 'system', 'user', '[]') $$,
  '23514', null, 'API-18: a system row is never a user turn (rate limits count those)');
select throws_ok(
  $$ insert into public.ai_messages (session_id, role, turn_kind, content)
     values ('00000000-0000-0000-0000-0000000050b1', 'user', 'context', '[]') $$,
  '23514', null, 'API-18: a context row is never a user message');
select throws_ok(
  $$ insert into public.ai_messages (session_id, role, turn_kind, content)
     values ('00000000-0000-0000-0000-0000000050b1', 'assistant', 'context', '[]') $$,
  '23514', null, 'API-18: a context row is never an assistant message');
select throws_ok(
  $$ insert into public.ai_messages (session_id, role, turn_kind, content)
     values ('00000000-0000-0000-0000-0000000050b1', 'tool', 'user', '[]') $$,
  '23514', null, 'API-18: no other role is allowed');
select is(
  (select array_agg(role order by created_at, id) from public.ai_session_history('00000000-0000-0000-0000-0000000050c2', 200)),
  array['user', 'system'],
  'API-18: the history walk returns the system row in its place on the branch');

-- The owner reads it like their other rows (the web skips it when drawing the chat).
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000050a1","role":"authenticated"}';
select is((select count(*)::int from public.ai_messages where session_id = '00000000-0000-0000-0000-0000000050b1' and role = 'system'), 1,
  'API-18: the owner sees the system row of their own session');

select * from finish();
rollback;
