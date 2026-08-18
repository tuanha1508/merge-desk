-- Harden Merge Desk durable cache against webhook over-growth and stale counts.

-- Drop the previous two-argument upsert so callers cannot bypass the cap.
drop function if exists public.merge_desk_upsert_queue(jsonb, integer);

create or replace function public.merge_desk_upsert_queue(
  items jsonb,
  retention_days integer default 7,
  max_items integer default 50
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
  if max_items is null or max_items < 1 then
    raise exception 'max_items must be >= 1';
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

  delete from public.merge_desk_queue_items
  where id in (
    select id
    from public.merge_desk_queue_items
    where expires_at > now()
    order by updated_at desc
    offset max_items
  );

  update public.merge_desk_state
  set item_count = (
    select count(*)::integer
    from public.merge_desk_queue_items
    where expires_at > now()
  )
  where key = 'queue';
end;
$$;

create or replace function public.merge_desk_cleanup_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.merge_desk_queue_items where expires_at <= now();
  delete from public.merge_desk_summaries where expires_at <= now();

  update public.merge_desk_state
  set item_count = (
    select count(*)::integer
    from public.merge_desk_queue_items
    where expires_at > now()
  )
  where key = 'queue';
end;
$$;

revoke all on function public.merge_desk_upsert_queue(jsonb, integer, integer)
  from public, anon, authenticated;
revoke all on function public.merge_desk_cleanup_expired()
  from public, anon, authenticated;
grant execute on function public.merge_desk_upsert_queue(jsonb, integer, integer)
  to service_role;
grant execute on function public.merge_desk_cleanup_expired()
  to service_role;
