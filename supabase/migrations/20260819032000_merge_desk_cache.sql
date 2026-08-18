-- Shared, seven-day persistence for Merge Desk.
-- The application accesses these objects only with SUPABASE_SERVICE_KEY.

create table if not exists public.merge_desk_queue_items (
  id text primary key,
  repo text not null,
  pr_number integer not null check (pr_number > 0),
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  payload jsonb not null,
  stored_at timestamptz not null default now()
);

create index if not exists merge_desk_queue_items_updated_at_idx
  on public.merge_desk_queue_items (updated_at desc);

create index if not exists merge_desk_queue_items_expires_at_idx
  on public.merge_desk_queue_items (expires_at);

create table if not exists public.merge_desk_summaries (
  content_hash text primary key,
  pr_key text not null,
  summary text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists merge_desk_summaries_expires_at_idx
  on public.merge_desk_summaries (expires_at);

create table if not exists public.merge_desk_state (
  key text primary key,
  item_count integer not null default 0 check (item_count >= 0),
  synced_at timestamptz not null default now()
);

alter table public.merge_desk_queue_items enable row level security;
alter table public.merge_desk_summaries enable row level security;
alter table public.merge_desk_state enable row level security;

revoke all on public.merge_desk_queue_items from anon, authenticated;
revoke all on public.merge_desk_summaries from anon, authenticated;
revoke all on public.merge_desk_state from anon, authenticated;
grant all on public.merge_desk_queue_items to service_role;
grant all on public.merge_desk_summaries to service_role;
grant all on public.merge_desk_state to service_role;

-- Replace the complete capped queue atomically. Partial five-row first-paint
-- fetches use ordinary upserts and never call this function, so they cannot
-- make an incomplete cache look authoritative.
create or replace function public.merge_desk_replace_queue(
  items jsonb,
  retention_days integer default 7
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;

  insert into public.merge_desk_queue_items (
    id,
    repo,
    pr_number,
    updated_at,
    expires_at,
    payload,
    stored_at
  )
  select
    item->>'id',
    item->>'repo',
    (item->>'number')::integer,
    (item->>'updatedAt')::timestamptz,
    greatest((item->>'updatedAt')::timestamptz, now())
      + make_interval(days => retention_days),
    item,
    now()
  from jsonb_array_elements(items) as item
  on conflict (id) do update set
    repo = excluded.repo,
    pr_number = excluded.pr_number,
    updated_at = excluded.updated_at,
    expires_at = excluded.expires_at,
    payload = excluded.payload,
    stored_at = excluded.stored_at;

  delete from public.merge_desk_queue_items stored
  where stored.id not in (
    select item->>'id' from jsonb_array_elements(items) as item
  );

  insert into public.merge_desk_state (key, item_count, synced_at)
  values ('queue', jsonb_array_length(items), now())
  on conflict (key) do update set
    item_count = excluded.item_count,
    synced_at = excluded.synced_at;
end;
$$;

revoke all on function public.merge_desk_replace_queue(jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.merge_desk_replace_queue(jsonb, integer)
  to service_role;

-- Patch one or more rows without claiming a full reconciliation. If a complete
-- snapshot already exists, keep its count accurate while preserving synced_at.
create or replace function public.merge_desk_upsert_queue(
  items jsonb,
  retention_days integer default 7
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;

  insert into public.merge_desk_queue_items (
    id,
    repo,
    pr_number,
    updated_at,
    expires_at,
    payload,
    stored_at
  )
  select
    item->>'id',
    item->>'repo',
    (item->>'number')::integer,
    (item->>'updatedAt')::timestamptz,
    greatest((item->>'updatedAt')::timestamptz, now())
      + make_interval(days => retention_days),
    item,
    now()
  from jsonb_array_elements(items) as item
  on conflict (id) do update set
    repo = excluded.repo,
    pr_number = excluded.pr_number,
    updated_at = excluded.updated_at,
    expires_at = excluded.expires_at,
    payload = excluded.payload,
    stored_at = excluded.stored_at;

  update public.merge_desk_state
  set item_count = (
    select count(*)::integer
    from public.merge_desk_queue_items
    where expires_at > now()
  )
  where key = 'queue';
end;
$$;

create or replace function public.merge_desk_delete_queue(item_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.merge_desk_queue_items where id = item_id;

  update public.merge_desk_state
  set item_count = (
    select count(*)::integer
    from public.merge_desk_queue_items
    where expires_at > now()
  )
  where key = 'queue';
end;
$$;

revoke all on function public.merge_desk_upsert_queue(jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.merge_desk_delete_queue(text)
  from public, anon, authenticated;
grant execute on function public.merge_desk_upsert_queue(jsonb, integer)
  to service_role;
grant execute on function public.merge_desk_delete_queue(text)
  to service_role;
