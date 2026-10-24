-- Phase 9: engagements (proposal -> acceptance -> build -> pilot -> run) and their transition log.
-- Website Improvement engagements live in website_engagements (web stream); this table holds
-- the non-standalone services only (lib/engagements/states.ts enforces that in code).
create table if not exists engagements (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  prospect_id uuid references prospects(id) on delete set null,
  assessment_id uuid references assessments(id) on delete set null,
  service_key text not null,
  status text not null default 'draft',               -- draft | proposed | accepted | building | testing | pilot | active | paused | completed
  setup_fee_cents int not null default 0 check (setup_fee_cents >= 0),
  monthly_fee_cents int not null default 0 check (monthly_fee_cents >= 0),
  credit_applied_cents int not null default 0 check (credit_applied_cents >= 0),
  -- proposal (commercial scope) fields
  defined_workflow text,
  included_volume int,
  volume_units text,
  usage_terms text,
  input_method text,                                   -- one of the service's inputMethods
  integration_key text,                                -- lib/catalog/integrations key, when an integration carries the input
  milestones jsonb not null default '[]'::jsonb,       -- [{title, due_on?, done?}]
  acceptance_criteria jsonb not null default '[]'::jsonb, -- [string]
  agency_contact text,
  deploi_owner text,
  approval_owner text,
  support_hours text,
  support_timezone text,
  escalation_contact text,
  fix_period_days int,
  initial_term_months int,
  exclusions jsonb not null default '[]'::jsonb,       -- [string], prefilled from the catalog
  change_request_process text,
  -- {method: email|signed_pdf|verbal_confirmed|portal, reference, accepted_by, accepted_at, recorded_by}
  acceptance_evidence jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists engagements_agency_idx on engagements (agency_id, created_at desc);
create index if not exists engagements_status_idx on engagements (status);

create table if not exists engagement_transitions (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid,
  at timestamptz not null default now(),
  note text,
  evidence jsonb
);
create index if not exists engagement_transitions_eng_idx on engagement_transitions (engagement_id, at);

-- A status change alone never proves acceptance: every status past 'proposed' needs recorded evidence.
create or replace function engagements_status_guard() returns trigger language plpgsql as $$
begin
  if new.status not in ('draft','proposed','accepted','building','testing','pilot','active','paused','completed') then
    raise exception 'invalid engagement status %', new.status;
  end if;
  if new.status not in ('draft','proposed') and (
       new.acceptance_evidence is null
       or jsonb_typeof(new.acceptance_evidence) <> 'object'
       or coalesce(new.acceptance_evidence ->> 'method', '') not in ('email','signed_pdf','verbal_confirmed','portal')
       or coalesce(new.acceptance_evidence ->> 'accepted_by', '') = ''
       or coalesce(new.acceptance_evidence ->> 'accepted_at', '') = '') then
    raise exception 'acceptance evidence is required before status %', new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists engagements_status_guard on engagements;
create trigger engagements_status_guard before insert or update of status, acceptance_evidence on engagements
  for each row execute function engagements_status_guard();

alter table engagements enable row level security;
alter table engagement_transitions enable row level security;
-- clients may read their own agency's engagement; only staff write
drop policy if exists engagements_tenant on engagements;
create policy engagements_tenant on engagements for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
drop policy if exists engagement_transitions_tenant on engagement_transitions;
create policy engagement_transitions_tenant on engagement_transitions for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
grant all on engagements, engagement_transitions to authenticated, service_role;

drop trigger if exists audit_engagements on engagements;
create trigger audit_engagements after insert or update or delete on engagements for each row execute function audit_row();
drop trigger if exists audit_engagement_transitions on engagement_transitions;
create trigger audit_engagement_transitions after insert or update or delete on engagement_transitions for each row execute function audit_row();
drop trigger if exists touch_updated_engagements on engagements;
create trigger touch_updated_engagements before update on engagements for each row execute function set_updated_at();
