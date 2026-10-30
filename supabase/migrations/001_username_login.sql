-- ============================================================================
--  M-HUSTLE · Username sign-in migration
--  Run this once in Supabase Dashboard → SQL Editor if your project was
--  created before username login was added.
-- ============================================================================

create or replace function public.login_email_for_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.login_email_for_username(text) from public;
grant execute on function public.login_email_for_username(text) to anon, authenticated;

-- Ask PostgREST to pick up the new function immediately.
notify pgrst, 'reload schema';

-- Verify (replace with a real username):
-- select public.login_email_for_username('amina_maseno');
