-- Assessment credit ledger (phase 8). Replaces the single amount on agencies with a history:
-- one credit per paid assessment, applications per engagement, never applied twice, never over the remainder.
create table if not exists assessment_credits (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  assessment_id uuid references assessments(id) on delete set null,
  original_fee_cents int not null check (original_fee_cents >= 0),
  payment_status text not null default 'unpaid',      -- unpaid | mock_paid | paid | refunded
  payment_is_mock boolean not null default true,       -- a mock checkout never becomes a paid credit
  paid_at timestamptz,
  eligible_service_key text,                           -- null = any non-standalone build
  credit_cents int not null check (credit_cents >= 0),
  applied_cents int not null default 0 check (applied_cents >= 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assessment_credits_agency_idx on assessment_credits (agency_id, issued_at desc);

create table if not exists assessment_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references assessment_credits(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  engagement_ref text not null,                        -- engagement id (text: engagements table lands in a later migration)
  service_key text not null,
  amount_cents int not null check (amount_cents > 0),
  applied_by uuid,
  applied_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversal_note text
);
create unique index if not exists credit_app_once_per_engagement on assessment_credit_applications (credit_id, engagement_ref) where reversed_at is null;

alter table assessment_credits enable row level security;
alter table assessment_credit_applications enable row level security;
drop policy if exists assessment_credits_tenant on assessment_credits;
create policy assessment_credits_tenant on assessment_credits for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
drop policy if exists credit_apps_tenant on assessment_credit_applications;
create policy credit_apps_tenant on assessment_credit_applications for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
grant all on assessment_credits, assessment_credit_applications to authenticated, service_role;
drop trigger if exists audit_assessment_credits on assessment_credits;
create trigger audit_assessment_credits after insert or update or delete on assessment_credits for each row execute function audit_row();
drop trigger if exists audit_credit_apps on assessment_credit_applications;
create trigger audit_credit_apps after insert or update or delete on assessment_credit_applications for each row execute function audit_row();
drop trigger if exists touch_updated_assessment_credits on assessment_credits;
create trigger touch_updated_assessment_credits before update on assessment_credits for each row execute function set_updated_at();

-- Backfill: agencies that already carry a legacy credit get one ledger row (payment status unknown -> unpaid, so it cannot be applied until confirmed).
insert into assessment_credits (agency_id, assessment_id, original_fee_cents, payment_status, payment_is_mock, credit_cents, applied_cents, issued_at, expires_at, note)
select g.id, (select a.id from assessments a where a.agency_id = g.id order by a.created_at desc limit 1),
       g.assessment_credit_cents, 'unpaid', true, g.assessment_credit_cents,
       case when g.assessment_credit_applied_at is not null then g.assessment_credit_cents else 0 end,
       coalesce(g.credit_expires_at - interval '60 days', now()), g.credit_expires_at, 'backfilled from agencies.assessment_credit_cents; confirm payment'
from agencies g
where g.assessment_credit_cents > 0 and not exists (select 1 from assessment_credits c where c.agency_id = g.id);
