-- Phase 16 (web stream): Website Improvement workflow + lead tagging.
-- Additive and idempotent. Staff-only records: website engagements are internal delivery
-- records, so even when agency_id is set a client user never reads them.

-- ---------------------------------------------------------------- prospects: service interest + tags + website details
alter table prospects add column if not exists service_interest text not null default 'operations'; -- operations | website_improvement
alter table prospects add column if not exists tags text[] not null default '{}';
alter table prospects add column if not exists website_url text;
alter table prospects add column if not exists website_goal text;
alter table prospects add column if not exists website_details jsonb not null default '{}'::jsonb;
create index if not exists prospects_tags_idx on prospects using gin (tags);
create index if not exists prospects_service_interest_idx on prospects (service_interest);

-- ---------------------------------------------------------------- website engagements
create table if not exists website_engagements (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,        -- an engagement belongs to its lead
  agency_id uuid references agencies(id) on delete set null,          -- optional link; rows stay staff-only regardless
  status text not null default 'inquiry',
    -- inquiry | scope_confirmed | accepted | payment_confirmed | access_received | improving | preview_ready
    -- | customer_approved | published | completed | cancelled
  website_url text,
  platform text,
  goal text,
  pages jsonb not null default '[]'::jsonb,                            -- up to 3 page references (strings)
  requested_changes text,
  known_issues text,
  access_status text not null default 'unknown',                       -- have_login | need_to_find | agency_managed | unknown
  access_arrangement text,                                             -- how access was arranged (e.g. "invited as editor"); never a secret
  approval_contact text,
  feasibility jsonb not null default '{}'::jsonb,                      -- { status: unconfirmed|feasible|not_feasible, note, confirmed_at, confirmed_by }
  price_cents int not null default 50000 check (price_cents >= 0),     -- fallback; code inserts getPricing().website.price
  payment_status text not null default 'unpaid',                       -- unpaid | mock_paid | paid | refunded
  payment_is_mock boolean not null default true,                       -- a mock payment never satisfies the payment gate
  paid_at timestamptz,
  scope_confirmed_at timestamptz,
  accepted_at timestamptz,
  acceptance_evidence jsonb,
  access_received_at timestamptz,
  content_received_at timestamptz,
  preview_url text,
  preview_ready_at timestamptz,
  customer_approved_at timestamptz,
  customer_approval_evidence jsonb,                                    -- { method, reference, approved_by, at, recorded_by }
  published_at timestamptz,
  publication_verified_at timestamptz,
  publication_verification jsonb,                                      -- { checked_urls, by, at, notes }
  backup_plan text,
  rollback_note text,
  handoff_summary text,
  before_after jsonb not null default '[]'::jsonb,                     -- [{ page, before_ref, after_ref, note }]
  approved_changes jsonb not null default '[]'::jsonb,                 -- [string]
  revision_round int not null default 0,
  revision_status text,
  target_date date,                                                    -- a target, not a guarantee (5 business days after the later of paid/access/content)
  maintenance_requested boolean not null default false,                -- creates nothing; a separate scope is required
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists website_engagements_prospect_idx on website_engagements (prospect_id);
create index if not exists website_engagements_status_idx on website_engagements (status);

create table if not exists website_labor (
  id uuid primary key default gen_random_uuid(),
  website_engagement_id uuid not null references website_engagements(id) on delete cascade,
  hours numeric(6,2) not null check (hours > 0),
  kind text not null default 'implementation',                         -- review | implementation | testing | revision | handoff
  note text,
  logged_by uuid,
  logged_at timestamptz not null default now()
);
create index if not exists website_labor_engagement_idx on website_labor (website_engagement_id, logged_at desc);

create table if not exists website_transitions (
  id uuid primary key default gen_random_uuid(),
  website_engagement_id uuid not null references website_engagements(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid,
  at timestamptz not null default now(),
  note text
);
create index if not exists website_transitions_engagement_idx on website_transitions (website_engagement_id, at desc);

-- RLS: staff only (these are internal delivery records, never tenant data).
alter table website_engagements enable row level security;
alter table website_labor enable row level security;
alter table website_transitions enable row level security;
drop policy if exists website_engagements_staff_all on website_engagements;
create policy website_engagements_staff_all on website_engagements for all to authenticated using (is_staff()) with check (is_staff());
drop policy if exists website_labor_staff_all on website_labor;
create policy website_labor_staff_all on website_labor for all to authenticated using (is_staff()) with check (is_staff());
drop policy if exists website_transitions_staff_all on website_transitions;
create policy website_transitions_staff_all on website_transitions for all to authenticated using (is_staff()) with check (is_staff());
grant all on website_engagements, website_labor, website_transitions to authenticated, service_role;
revoke all on website_engagements, website_labor, website_transitions from anon;

-- audit + updated_at
drop trigger if exists audit_website_engagements on website_engagements;
create trigger audit_website_engagements after insert or update or delete on website_engagements for each row execute function audit_row();
drop trigger if exists audit_website_labor on website_labor;
create trigger audit_website_labor after insert or update or delete on website_labor for each row execute function audit_row();
drop trigger if exists audit_website_transitions on website_transitions;
create trigger audit_website_transitions after insert or update or delete on website_transitions for each row execute function audit_row();
drop trigger if exists touch_updated_website_engagements on website_engagements;
create trigger touch_updated_website_engagements before update on website_engagements for each row execute function set_updated_at();

-- ---------------------------------------------------------------- secrets never land in website_details
-- Removes any key whose name looks like a credential (password, pass, pwd, passwd, passphrase, login, secret, token).
create or replace function website_strip_secret_keys(p jsonb) returns jsonb
language sql immutable as $$
  select coalesce((
    select jsonb_object_agg(k, v) from jsonb_each(coalesce(p, '{}'::jsonb)) as x(k, v)
    where k !~* '^(password|passwd|passphrase|pass|pwd|login|secret|token)$'
  ), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------- public lead v2 (v1 stays as is)
-- Same dedupe as v1 (email + agency_name). Extra fields are optional. A website lead tags the prospect
-- 'Website Improvement', stores website details (secret-looking keys stripped) and creates one
-- website_engagements row in status 'inquiry' (reused if the prospect already has one in 'inquiry').
create or replace function public_create_lead_v2(
  p_name text, p_email text, p_agency_name text, p_phone text, p_message text, p_source text,
  p_city text default null, p_county text default null, p_state text default 'OH',
  p_service_interest text default 'operations',
  p_website_url text default null, p_website_platform text default null, p_website_goal text default null,
  p_website_pages jsonb default '[]'::jsonb, p_website_changes text default null, p_website_issues text default null,
  p_access_status text default 'unknown', p_approval_contact text default null, p_price_cents int default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_agency text; v_interest text; v_access text; v_pages jsonb; v_details jsonb; v_eng uuid;
begin
  if p_source not in ('site','evv-page','chat') then
    raise exception 'invalid source';
  end if;
  v_interest := case when p_service_interest = 'website_improvement' then 'website_improvement' else 'operations' end;
  v_access := case when p_access_status in ('have_login','need_to_find','agency_managed','unknown') then p_access_status else 'unknown' end;
  v_pages := case when jsonb_typeof(coalesce(p_website_pages, '[]'::jsonb)) = 'array'
                  then (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(p_website_pages) with ordinality as t(e, n) where jsonb_typeof(e) = 'string' and n <= 3) s)
                  else '[]'::jsonb end;
  v_details := website_strip_secret_keys(jsonb_strip_nulls(jsonb_build_object(
    'platform', p_website_platform, 'pages', v_pages, 'changes', p_website_changes, 'issues', p_website_issues,
    'access_status', v_access, 'approval_contact', p_approval_contact)));
  v_agency := coalesce(nullif(trim(p_agency_name), ''), 'Unknown agency');
  select id into v_id from prospects
    where lower(email) = lower(p_email) and lower(agency_name) = lower(v_agency) limit 1;
  if v_id is null then
    insert into prospects (agency_name, owner_name, email, phone, city, county, state, source, stage,
                           service_interest, tags, website_url, website_goal, website_details)
    values (v_agency, p_name, p_email, p_phone, p_city, p_county, coalesce(p_state,'OH'), p_source, 'new',
            v_interest, case when v_interest = 'website_improvement' then array['Website Improvement'] else '{}'::text[] end,
            case when v_interest = 'website_improvement' then p_website_url end,
            case when v_interest = 'website_improvement' then p_website_goal end,
            case when v_interest = 'website_improvement' then v_details else '{}'::jsonb end)
    returning id into v_id;
  elsif v_interest = 'website_improvement' then
    update prospects set
      service_interest = 'website_improvement',
      tags = case when 'Website Improvement' = any(tags) then tags else array_append(tags, 'Website Improvement') end,
      website_url = coalesce(p_website_url, website_url),
      website_goal = coalesce(p_website_goal, website_goal),
      website_details = website_details || v_details
    where id = v_id;
  end if;
  insert into touches (prospect_id, channel, direction, subject, body, meta)
  values (v_id, case when p_source = 'chat' then 'chat'::touch_channel else 'site'::touch_channel end,
          'inbound', 'Lead from ' || p_source, p_message, jsonb_build_object('source', p_source, 'service_interest', v_interest));
  if v_interest = 'website_improvement' then
    select id into v_eng from website_engagements where prospect_id = v_id and status = 'inquiry' order by created_at desc limit 1;
    if v_eng is null then
      insert into website_engagements (prospect_id, agency_id, status, website_url, platform, goal, pages, requested_changes, known_issues,
                                       access_status, approval_contact, price_cents)
      select v_id, p.agency_id, 'inquiry', p_website_url, p_website_platform, p_website_goal, v_pages, p_website_changes, p_website_issues,
             v_access, p_approval_contact, coalesce(p_price_cents, 50000)
      from prospects p where p.id = v_id;
    end if;
  end if;
  return v_id;
end $$;
grant execute on function public_create_lead_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,int) to anon, authenticated, service_role;
grant execute on function website_strip_secret_keys(jsonb) to anon, authenticated, service_role;

-- The leads view was created with select * before these columns existed; refresh it so the new columns show.
create or replace view leads as
  select * from prospects where source in ('site', 'evv-page', 'chat');
