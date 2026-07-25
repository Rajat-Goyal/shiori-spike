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
    processing_status,
    is_owner_private
  )
  values (
    p_update_id,
    'claimed',
    p_owner_chat_id is not null
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
    on conflict do nothing;

    update public.conversation_permission_candidates
    set correlated_update_id = p_update_id
    where
      singleton = true
      and correlated_update_id is null
      and source_update_id <> p_update_id;
  end if;

  return coalesce(claimed, false);
end;
$$;
