/*
  The conversation's date as a stored system message (API-18). Claude binds each thinking block
  to the exact system prompt and earlier messages; the chat put "Danas je …" in the system
  prompt of every request, so after midnight the prompt differed and every later turn of an open
  chat failed with 400 "bound to a different conversation". The date now travels as a
  mid-conversation `role: 'system'` message after the user's message, stored as its own row so
  every later request replays it byte for byte, and a new one is added when the day changes.

  ai_messages gains role 'system' with turn_kind 'context' (and only that pairing). Rate limits
  count turn_kind = 'user' only, so a context row is never a user turn. Nothing else changes:
  RLS, grants and ai_session_history already treat rows alike.

  After applying: nothing by hand; apply it BEFORE deploying the API that writes these rows (the
  old CHECK refuses them). No generated type changes (CHECKs only).
*/

ALTER TABLE public.ai_messages DROP CONSTRAINT IF EXISTS ai_messages_role_check;
ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant', 'system'));

ALTER TABLE public.ai_messages DROP CONSTRAINT IF EXISTS ai_messages_turn_kind_check;
ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_turn_kind_check CHECK (turn_kind IN ('user', 'assistant', 'tool_result', 'context'));

ALTER TABLE public.ai_messages DROP CONSTRAINT IF EXISTS ai_messages_role_kind;
ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_role_kind CHECK (
    (role = 'assistant' AND turn_kind = 'assistant')
    OR (role = 'user' AND turn_kind IN ('user', 'tool_result'))
    OR (role = 'system' AND turn_kind = 'context')
  );

COMMENT ON COLUMN public.ai_messages.role IS
  'The Anthropic wire role: user, assistant, or system (a mid-conversation context message, API-18). Tool results travel as user messages.';
COMMENT ON COLUMN public.ai_messages.turn_kind IS
  'user (a real user turn), assistant, tool_result, or context (a system row such as the date). Rate limits count only turn_kind = user.';
