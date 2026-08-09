-- Conversational plan assistant (F11): an append-only transcript of every
-- chat turn, per user. user_id is text (not uuid) to match profiles.id's
-- type since the 0034 Auth0 identity swap -- Auth0 subject ids aren't
-- valid uuids. action_taken records what the assistant actually did (or
-- proposed) for a given turn, for auditability/debugging and to support
-- the clamp-confirmation flow (a pending suggestion stored on an
-- assistant row is read back on the user's next message).

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  action_taken jsonb,
  created_at timestamptz not null default now()
);

create index chat_messages_user_id_created_at_idx
  on public.chat_messages (user_id, created_at);

alter table public.chat_messages enable row level security;

-- No update/delete policy -- an append-only transcript, same as every
-- other insert-only log table in this schema.
create policy "Users can read their own chat messages"
on public.chat_messages for select
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can insert their own chat messages"
on public.chat_messages for insert
with check ((auth.jwt() ->> 'sub') = user_id);
