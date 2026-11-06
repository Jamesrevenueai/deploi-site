-- =============================================================================
-- Connections for the launch build (workstream W3): Salesforce, Pipedrive and Zoho CRM (OAuth 2.0), Buildium
-- (API key), Outlook calendar on the connected Microsoft 365 account, and change detection for all of them.
--  * office_connections / office_oauth_states accept the new providers (lists EXTENDED, never redefined).
--  * office_connections.api_base: the provider host a connection is bound to (Salesforce instance URL, Pipedrive
--    company domain, Zoho data-center API domain, Buildium production or sandbox). Checked again in code against
--    the approved hosts before every request; never taken from a request.
--  * connection_health / connection_health_state accept the new integration keys.
--  * email_oauth_states.want_calendar: a Microsoft 365 connection asked for mail AND calendar.
--  * connection_sync_cursors: where each change poll / delta query stopped (one row per connection and stream).
--  * connection_events: one row per provider change turned into an agent event, so the same change is never
--    handed to the agents twice. Ids and times only: no names, addresses or message content.
-- Same RLS model as the rest of the platform: members read their organization's rows, staff read all, every
-- write is server code (service role). Tokens and API keys stay in office_credentials / email_credentials (encrypted).
-- Rollback: supabase/rollback/20261107000060_connections_crm_buildium.down.sql
-- =============================================================================

create or replace function pg_temp.extend_in_check(t text, c text, col text, val text) returns void language plpgsql as $$
declare def text; vals text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = t::regclass and conname = c;
  if def is null then raise exception 'constraint %.% is missing', t, c; end if;
  if position(quote_literal(val) in def) > 0 then return; end if;
  vals := substring(def from 'ARRAY\[(.*)\]');
  if vals is null then raise exception 'constraint %.% is not a value list: %', t, c, def; end if;
  execute format('alter table %I drop constraint %I', t, c);
  execute format('alter table %I add constraint %I check (%I = any (array[%s, %L::text]))', t, c, col, vals, val);
end $$;

do $$ declare p text; begin
  foreach p in array array['salesforce', 'pipedrive', 'zoho_crm', 'buildium'] loop
    perform pg_temp.extend_in_check('office_connections', 'office_connections_provider_check', 'provider', p);
    perform pg_temp.extend_in_check('connection_health', 'connection_health_integration_check', 'integration', p);
    perform pg_temp.extend_in_check('connection_health_state', 'connection_health_state_integration_check', 'integration', p);
  end loop;
  -- Buildium connects with an API key, never through OAuth
  foreach p in array array['salesforce', 'pipedrive', 'zoho_crm'] loop
    perform pg_temp.extend_in_check('office_oauth_states', 'office_oauth_states_provider_check', 'provider', p);
  end loop;
end $$;

alter table office_connections add column if not exists api_base text
  check (api_base is null or api_base ~ '^https://[a-z0-9]([a-z0-9.-]{0,200}[a-z0-9])?$');

alter table email_oauth_states add column if not exists want_calendar boolean not null default false;

create table if not exists connection_sync_cursors (
  org_id uuid not null references agencies(id) on delete cascade,
  -- an office connection or an email account (two tables), so no foreign key; rows go with their organization
  connection_id uuid not null,
  -- e.g. 'crm.contacts', 'buildium.workorders', 'outlook.calendar', 'quickbooks.cdc'
  stream text not null check (stream ~ '^[a-z][a-z0-9_.]{1,60}$'),
  -- the provider's own position: a timestamp, a delta link or a page token (never a credential)
  sync_position text check (length(sync_position) <= 4000),
  last_polled_at timestamptz,
  last_changes int not null default 0 check (last_changes >= 0),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,40}$'),
  updated_at timestamptz not null default now(),
  primary key (connection_id, stream)
);
create index if not exists connection_sync_cursors_org on connection_sync_cursors (org_id);

create table if not exists connection_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  source text not null check (source in ('outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox')),
  type text not null check (type ~ '^[a-z][a-z0-9_.]{1,60}$'),
  -- the provider's id of the change (record id + version, message id): the dedupe key
  external_id text not null check (length(external_id) between 1 and 400),
  connection_id uuid,
  occurred_at timestamptz not null,
  handlers int not null default 0 check (handlers >= 0),
  created_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
create index if not exists connection_events_org on connection_events (org_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['connection_sync_cursors', 'connection_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
