create table public.telegram_updates (
  update_id bigint primary key,
  processing_status text not null
    check (processing_status in ('claimed', 'processed', 'failed')),
  processing_result text
    check (
      processing_result is null
      or processing_result in (
        'failed',
        'ignored',
        'refused',
        'status_empty',
        'unsupported'
      )
    ),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.telegram_owner_delivery (
  singleton boolean primary key default true check (singleton),
  private_chat_id bigint not null unique,
  captured_at timestamptz not null default now()
);

alter table public.telegram_updates enable row level security;
alter table public.telegram_owner_delivery enable row level security;

revoke all on table public.telegram_updates from anon, authenticated;
revoke all on table public.telegram_owner_delivery from anon, authenticated;
grant select on table public.telegram_updates to service_role;
grant select on table public.telegram_owner_delivery to service_role;

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_owner_chat_id bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status
  )
  values (
    p_update_id,
    'claimed'
  )
  on conflict (update_id) do nothing
  returning true into claimed;

  if coalesce(claimed, false) and p_owner_chat_id is not null then
    insert into public.telegram_owner_delivery (
      singleton,
      private_chat_id
    )
    values (
      true,
      p_owner_chat_id
    )
    on conflict (singleton) do nothing;
  end if;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.complete_telegram_update(
  p_update_id bigint,
  p_processing_result text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed boolean := false;
begin
  if p_processing_result not in (
    'failed',
    'ignored',
    'refused',
    'status_empty',
    'unsupported'
  ) then
    raise exception 'invalid Telegram processing result';
  end if;

  update public.telegram_updates
  set
    processing_status = case
      when p_processing_result = 'failed' then 'failed'
      else 'processed'
    end,
    processing_result = p_processing_result,
    processed_at = now()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  return coalesce(completed, false);
end;
$$;

revoke all on function public.claim_telegram_update(bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.complete_telegram_update(bigint, text)
  from public, anon, authenticated;
grant execute on function public.claim_telegram_update(bigint, bigint)
  to service_role;
grant execute on function public.complete_telegram_update(bigint, text)
  to service_role;
