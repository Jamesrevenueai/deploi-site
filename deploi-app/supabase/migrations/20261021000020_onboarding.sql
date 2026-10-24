-- Phase 10: onboarding checklist per engagement. Defaults come from lib/onboarding/checklist.ts;
-- readiness and the launch gates are computed in lib/onboarding/readiness.ts and enforced in
-- lib/engagements/transition.ts. evidence.simulated = true never satisfies a live gate.
create table if not exists onboarding_items (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  key text not null,
  label text not null,
  dimension text not null check (dimension in ('configuration','data_quality','security_controls','integration_verification','operational_readiness','commercial_readiness')),
  required boolean not null default true,
  sort_order int not null default 0,
  completed_at timestamptz,
  completed_by uuid,
  note text,
  evidence jsonb,                                      -- {simulated?: bool, mocked?: bool, method?, reference?, ...}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (engagement_id, key)
);
create index if not exists onboarding_items_eng_idx on onboarding_items (engagement_id, sort_order);

alter table onboarding_items enable row level security;
drop policy if exists onboarding_items_tenant on onboarding_items;
create policy onboarding_items_tenant on onboarding_items for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
grant all on onboarding_items to authenticated, service_role;

drop trigger if exists audit_onboarding_items on onboarding_items;
create trigger audit_onboarding_items after insert or update or delete on onboarding_items for each row execute function audit_row();
drop trigger if exists touch_updated_onboarding_items on onboarding_items;
create trigger touch_updated_onboarding_items before update on onboarding_items for each row execute function set_updated_at();
