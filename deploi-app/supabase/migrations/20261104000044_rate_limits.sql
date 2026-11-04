-- =============================================================================
-- Rate limits (security review F-12). Vercel functions keep no memory between requests and there is no
-- Redis, so the counters live here: one row per (bucket, key, window_start), incremented atomically by
-- rate_limit_hit() (INSERT .. ON CONFLICT DO UPDATE serialises concurrent hits on the same row, so N
-- parallel hits always see the counts 1..N). Keys are a client IP or an organization/user id, never
-- personal data beyond the IP. Rows expire after two windows (the sliding estimate reads the previous one)
-- and are deleted by rate_limits_cleanup(), called opportunistically by lib/security/rate-limit.ts.
-- Server only: RLS on with no policy, no user-role privileges, functions executable by service_role only.
-- Rollback: supabase/rollback/20261104000044_rate_limits.down.sql
-- =============================================================================
create table if not exists rate_limits (
  bucket text not null check (length(bucket) between 1 and 64),
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0,
  expires_at timestamptz not null,
  primary key (bucket, key, window_start)
);
create index if not exists rate_limits_expires_idx on rate_limits (expires_at);

alter table rate_limits enable row level security;
revoke all on rate_limits from public, anon, authenticated;
grant all on rate_limits to service_role;

-- Count one hit (or p_cost hits) in the current fixed window and return it with the previous window's
-- count, the window start and how far into the window the hit landed. p_at is for tests only.
create or replace function rate_limit_hit(p_bucket text, p_key text, p_window_seconds integer, p_cost integer default 1, p_at timestamptz default null)
returns table (hits integer, prev_hits integer, window_start timestamptz, elapsed_ms double precision)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  t timestamptz := coalesce(p_at, clock_timestamp());
  ws timestamptz;
  h integer;
  p integer;
begin
  if p_window_seconds is null or p_window_seconds < 1 then raise exception 'rate_limit_hit: window must be at least one second'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'rate_limit_hit: cost must not be negative'; end if;
  ws := to_timestamp(floor(extract(epoch from t) / p_window_seconds) * p_window_seconds);
  insert into rate_limits as r (bucket, key, window_start, hits, expires_at)
    values (p_bucket, p_key, ws, p_cost, ws + make_interval(secs => 2 * p_window_seconds))
    on conflict (bucket, key, window_start) do update set hits = r.hits + excluded.hits
    returning r.hits into h;
  select r.hits into p from rate_limits r
    where r.bucket = p_bucket and r.key = p_key and r.window_start = ws - make_interval(secs => p_window_seconds);
  return query select h, coalesce(p, 0), ws, (extract(epoch from (t - ws)) * 1000)::double precision;
end $$;

-- Delete expired windows, at most p_limit rows per call (keeps each call short).
create or replace function rate_limits_cleanup(p_limit integer default 5000) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from rate_limits where ctid in (select ctid from rate_limits where expires_at < clock_timestamp() limit greatest(p_limit, 1));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function rate_limit_hit(text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function rate_limits_cleanup(integer) from public, anon, authenticated;
grant execute on function rate_limit_hit(text, text, integer, integer, timestamptz) to service_role;
grant execute on function rate_limits_cleanup(integer) to service_role;
