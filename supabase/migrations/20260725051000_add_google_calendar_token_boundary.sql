create or replace function public.read_google_calendar_credential()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'verified_email', verified_email,
    'refresh_token_ciphertext', refresh_token_ciphertext,
    'refresh_token_nonce', refresh_token_nonce,
    'refresh_token_tag', refresh_token_tag,
    'key_version', key_version,
    'status', status,
    'calendar_id', calendar_id,
    'scopes', scopes
  )
  from public.google_calendar_connection
  where singleton = true;
$$;

create or replace function public.mark_google_calendar_authorization_expired()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.google_calendar_connection
  set
    status = 'authorization_expired',
    updated_at = now()
  where singleton = true;

  return found;
end;
$$;

revoke all on function public.read_google_calendar_credential()
  from public, anon, authenticated;
revoke all on function public.mark_google_calendar_authorization_expired()
  from public, anon, authenticated;

grant execute on function public.read_google_calendar_credential()
  to service_role;
grant execute on function public.mark_google_calendar_authorization_expired()
  to service_role;
