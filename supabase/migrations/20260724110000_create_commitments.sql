create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  definition_of_done text not null,
  target_at timestamptz not null,
  status text not null check (status in ('active', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint commitments_terminal_timestamps_check check (
    (status = 'active' and completed_at is null and cancelled_at is null)
    or (status = 'done' and completed_at is not null and cancelled_at is null)
    or (status = 'cancelled' and completed_at is null and cancelled_at is not null)
  )
);

create index commitments_active_target_idx
  on public.commitments (target_at)
  where status = 'active';

alter table public.commitments enable row level security;

revoke all on table public.commitments from anon, authenticated;
grant select on table public.commitments to service_role;
