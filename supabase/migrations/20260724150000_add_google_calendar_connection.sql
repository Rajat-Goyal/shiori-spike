create table public.google_oauth_attempts (
  state_digest text primary key check (char_length(state_digest) = 43),
  session_digest text not null unique check (char_length(session_digest) = 43),
  nonce_digest text not null check (char_length(nonce_digest) = 43),
  verifier_ciphertext text not null check (char_length(verifier_ciphertext) > 0),
  verifier_nonce text not null check (char_length(verifier_nonce) = 16),
  verifier_tag text not null check (char_length(verifier_tag) = 24),
  key_version integer not null check (key_version > 0),
  intent text not null check (intent in ('connect', 'reconnect')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table public.google_oauth_outcomes (
  session_digest text primary key check (char_length(session_digest) = 43),
  outcome text not null check (
    outcome in (
      'connected',
      'reconnected',
      'invalid_state',
      'identity_mismatch',
      'denied',
      'failed'
    )
  ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table public.google_calendar_connection (
  singleton boolean primary key default true check (singleton),
  verified_email text not null,
  refresh_token_ciphertext text not null
    check (char_length(refresh_token_ciphertext) > 0),
  refresh_token_nonce text not null
    check (char_length(refresh_token_nonce) = 16),
  refresh_token_tag text not null
    check (char_length(refresh_token_tag) = 24),
  key_version integer not null check (key_version > 0),
  scopes text[] not null check (
    scopes = array[
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy'
    ]::text[]
  ),
  calendar_id text not null default 'primary' check (calendar_id = 'primary'),
  status text not null default 'connected'
    check (status in ('connected', 'authorization_expired')),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_successful_check_at timestamptz
);

alter table public.google_oauth_attempts enable row level security;
alter table public.google_oauth_outcomes enable row level security;
alter table public.google_calendar_connection enable row level security;

revoke all on table public.google_oauth_attempts from anon, authenticated;
revoke all on table public.google_oauth_outcomes from anon, authenticated;
revoke all on table public.google_calendar_connection from anon, authenticated;
grant select on table public.google_oauth_attempts to service_role;
grant select on table public.google_oauth_outcomes to service_role;
grant select on table public.google_calendar_connection to service_role;

create or replace function public.create_google_oauth_attempt(
  p_state_digest text,
  p_session_digest text,
  p_nonce_digest text,
  p_verifier_ciphertext text,
  p_verifier_nonce text,
  p_verifier_tag text,
  p_key_version integer,
  p_intent text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'invalid Google OAuth attempt expiry';
  end if;

  delete from public.google_oauth_attempts
  where expires_at <= now() or session_digest = p_session_digest;

  insert into public.google_oauth_attempts (
    state_digest,
    session_digest,
    nonce_digest,
    verifier_ciphertext,
    verifier_nonce,
    verifier_tag,
    key_version,
    intent,
    expires_at
  )
  values (
    p_state_digest,
    p_session_digest,
    p_nonce_digest,
    p_verifier_ciphertext,
    p_verifier_nonce,
    p_verifier_tag,
    p_key_version,
    p_intent,
    p_expires_at
  );

  return true;
end;
$$;

create or replace function public.claim_google_oauth_attempt(
  p_state_digest text,
  p_session_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.google_oauth_attempts;
begin
  delete from public.google_oauth_attempts
  where
    state_digest = p_state_digest
    and session_digest = p_session_digest
    and expires_at > now()
  returning * into claimed;

  if claimed.state_digest is null then
    return null;
  end if;

  return jsonb_build_object(
    'nonce_digest', claimed.nonce_digest,
    'verifier_ciphertext', claimed.verifier_ciphertext,
    'verifier_nonce', claimed.verifier_nonce,
    'verifier_tag', claimed.verifier_tag,
    'key_version', claimed.key_version,
    'intent', claimed.intent
  );
end;
$$;

create or replace function public.store_google_oauth_outcome(
  p_session_digest text,
  p_outcome text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'invalid Google OAuth outcome expiry';
  end if;

  delete from public.google_oauth_outcomes
  where expires_at <= now();

  insert into public.google_oauth_outcomes (
    session_digest,
    outcome,
    expires_at
  )
  values (
    p_session_digest,
    p_outcome,
    p_expires_at
  )
  on conflict (session_digest) do update
  set
    outcome = excluded.outcome,
    expires_at = excluded.expires_at,
    created_at = now();

  return true;
end;
$$;

create or replace function public.consume_google_oauth_outcome(
  p_session_digest text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumed text;
begin
  delete from public.google_oauth_outcomes
  where expires_at <= now();

  delete from public.google_oauth_outcomes
  where
    session_digest = p_session_digest
  returning outcome into consumed;

  return consumed;
end;
$$;

create or replace function public.replace_google_calendar_connection(
  p_verified_email text,
  p_refresh_token_ciphertext text,
  p_refresh_token_nonce text,
  p_refresh_token_tag text,
  p_key_version integer,
  p_scopes text[],
  p_calendar_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.google_calendar_connection (
    singleton,
    verified_email,
    refresh_token_ciphertext,
    refresh_token_nonce,
    refresh_token_tag,
    key_version,
    scopes,
    calendar_id,
    status
  )
  values (
    true,
    p_verified_email,
    p_refresh_token_ciphertext,
    p_refresh_token_nonce,
    p_refresh_token_tag,
    p_key_version,
    p_scopes,
    p_calendar_id,
    'connected'
  )
  on conflict (singleton) do update
  set
    verified_email = excluded.verified_email,
    refresh_token_ciphertext = excluded.refresh_token_ciphertext,
    refresh_token_nonce = excluded.refresh_token_nonce,
    refresh_token_tag = excluded.refresh_token_tag,
    key_version = excluded.key_version,
    scopes = excluded.scopes,
    calendar_id = excluded.calendar_id,
    status = 'connected',
    connected_at = now(),
    updated_at = now();

  return true;
end;
$$;

create or replace function public.read_google_calendar_connection_state()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'verified_email', verified_email,
    'key_version', key_version,
    'status', status,
    'last_successful_check_at', last_successful_check_at,
    'calendar_id', calendar_id,
    'scopes', scopes
  )
  from public.google_calendar_connection
  where singleton = true;
$$;

revoke all on function public.create_google_oauth_attempt(
  text, text, text, text, text, text, integer, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.claim_google_oauth_attempt(text, text)
  from public, anon, authenticated;
revoke all on function public.store_google_oauth_outcome(
  text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_google_oauth_outcome(text)
  from public, anon, authenticated;
revoke all on function public.replace_google_calendar_connection(
  text, text, text, text, integer, text[], text
) from public, anon, authenticated;
revoke all on function public.read_google_calendar_connection_state()
  from public, anon, authenticated;

grant execute on function public.create_google_oauth_attempt(
  text, text, text, text, text, text, integer, text, timestamptz
) to service_role;
grant execute on function public.claim_google_oauth_attempt(text, text)
  to service_role;
grant execute on function public.store_google_oauth_outcome(
  text, text, timestamptz
) to service_role;
grant execute on function public.consume_google_oauth_outcome(text)
  to service_role;
grant execute on function public.replace_google_calendar_connection(
  text, text, text, text, integer, text[], text
) to service_role;
grant execute on function public.read_google_calendar_connection_state()
  to service_role;
