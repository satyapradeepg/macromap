-- 0035 deliberately made chat_messages append-only (no update/delete
-- policy), matching this schema's other insert-only log/cache tables --
-- reasonable at the time, before a user-facing "clear conversation"
-- feature existed. Now that both the chat widget's own reset action and
-- deleteAccount() need to delete a user's rows, the missing policy means
-- those deletes silently no-op under RLS (0 rows affected, no error
-- surfaced) rather than actually removing anything -- same class of gap
-- 0031 fixed for meal_plans' missing UPDATE policy.
create policy "Users can delete their own chat messages"
on public.chat_messages for delete
using ((auth.jwt() ->> 'sub') = user_id);
