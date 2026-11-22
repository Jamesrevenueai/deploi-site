-- 065: Missed Call and Booking agents (Office, Track B). Behind OFFICE_PHONE_AGENTS (off by default).
--   office_phone_lines   the business's own phone number(s): maps an inbound call or text to its organization
--   phone_calls          every missed call, once per provider call id, and what the Missed Call agent did about it
--   phone_texts          every inbound text, once per provider message id (the agents' input)
--   notify_outbox        may now also hold texts to a customer (the caller), not only to the owner or crew
--   agent_events         new event source 'phone' (call.missed, sms.received)
-- Additive only: no column is dropped and no existing row changes. Rollback: supabase/rollback/20261122000065_phone_agents.down.sql.

create table if not exists office_phone_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  phone_number text not null unique check (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  provider text not null default 'twilio' check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text check (length(label) <= 80),
  -- the phone that rings first (the owner's mobile); a call it does not answer is a missed call
  forward_to text check (forward_to is null or forward_to ~ '^\+[1-9][0-9]{6,14}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_phone_lines_org on office_phone_lines (org_id);

create table if not exists phone_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  provider_call_id text not null check (length(provider_call_id) between 1 and 120),
  from_phone text not null check (from_phone ~ '^\+[1-9][0-9]{6,14}$'),
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{6,14}$'),
  call_status text not null check (call_status in ('no-answer', 'busy', 'failed', 'canceled', 'missed')),
  occurred_at timestamptz not null,
  state text not null default 'new' check (state in ('new', 'texted', 'captured', 'booked', 'closed', 'opted_out', 'held')),
  texted_at timestamptz,
  lead_id uuid references pack_leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider_call_id)
);
create index if not exists phone_calls_org_from on phone_calls (org_id, from_phone, occurred_at desc);

create table if not exists phone_texts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  provider_message_id text not null check (length(provider_message_id) between 1 and 120),
  from_phone text not null check (from_phone ~ '^\+[1-9][0-9]{6,14}$'),
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{6,14}$'),
  body text not null check (length(body) <= 1600),
  received_at timestamptz not null default now(),
  unique (org_id, provider_message_id)
);
create index if not exists phone_texts_org_from on phone_texts (org_id, from_phone, received_at desc);

alter table notify_outbox drop constraint if exists notify_outbox_audience_check;
alter table notify_outbox add constraint notify_outbox_audience_check check (audience in ('owner', 'crew', 'customer'));

alter table agent_events drop constraint if exists agent_events_source_check;
alter table agent_events add constraint agent_events_source_check
  check (source in ('shopify', 'outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox', 'sweep', 'crew', 'manual', 'phone'));

do $$ declare t text; begin
  foreach t in array array['office_phone_lines', 'phone_calls', 'phone_texts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
    if t <> 'phone_texts' then
      execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
      execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Office sign-up from getdeploi.com (service businesses)
-- Same pipeline as early access (prospects + touches, staff see it under Early access), as the anon role through this
-- SECURITY DEFINER function only. Behind the site's VITE_OFFICE_SIGNUP and the app's OFFICE_SIGNUP flags (off by default).
create or replace function public_create_office_signup(
  p_name text, p_email text, p_company text, p_phone text, p_business_type text, p_trade text, p_tools text[], p_website text, p_message text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_company text; v_type text; v_trade text; v_tools text[]; v_phone text; v_site text; v_tags text[];
begin
  if p_email is null or p_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'invalid email'; end if;
  v_type := case when p_business_type in ('home_services','property_manager','real_estate_agent','leasing_agent','office') then p_business_type else null end;
  if v_type is null then raise exception 'invalid business type'; end if;
  v_trade := case when p_trade in ('construction','hvac','roofing','landscaping','cleaning','general') then p_trade else null end;
  select coalesce(array_agg(distinct t order by t), '{}') into v_tools from unnest(coalesce(p_tools, '{}')) t
    where t in ('outlook','google','quickbooks','hubspot','salesforce','pipedrive','zoho','buildium','other');
  v_phone := case when regexp_replace(coalesce(p_phone, ''), '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$' then regexp_replace(p_phone, '[\s\-().]', '', 'g') else null end;
  v_site := case when p_website ~* '^https?://[^\s/]+\.[^\s]+' then left(p_website, 500) else null end;
  v_company := coalesce(nullif(left(trim(p_company), 200), ''), 'Unknown business');
  v_tags := array['Office sign-up', initcap(replace(v_type, '_', ' '))] || case when v_trade is not null then array[initcap(v_trade)] else '{}'::text[] end;
  select id into v_id from prospects where lower(email) = lower(p_email) and lower(agency_name) = lower(v_company) limit 1;
  if v_id is null then
    insert into prospects (agency_name, owner_name, email, state, source, stage, service_interest, tags, website_url, website_details)
    values (v_company, left(p_name, 120), p_email, '', 'site', 'new', 'office_signup', v_tags, v_site,
            jsonb_strip_nulls(jsonb_build_object('business_type', v_type, 'trade', v_trade, 'tools', to_jsonb(v_tools), 'phone', v_phone)))
    returning id into v_id;
  else
    update prospects set service_interest = 'office_signup', tags = (select array(select distinct t from unnest(tags || v_tags) t)),
      website_url = coalesce(website_url, v_site),
      website_details = website_details || jsonb_strip_nulls(jsonb_build_object('business_type', v_type, 'trade', v_trade, 'tools', to_jsonb(v_tools), 'phone', v_phone))
    where id = v_id;
  end if;
  insert into touches (prospect_id, channel, direction, subject, body, meta)
  values (v_id, 'site', 'inbound', 'Office sign-up', left(p_message, 4000), jsonb_build_object('source', 'site', 'business_type', v_type, 'tools', to_jsonb(v_tools)));
  return v_id;
end $$;
revoke all on function public_create_office_signup(text,text,text,text,text,text,text[],text,text) from public;
grant execute on function public_create_office_signup(text,text,text,text,text,text,text[],text,text) to anon, authenticated, service_role;
