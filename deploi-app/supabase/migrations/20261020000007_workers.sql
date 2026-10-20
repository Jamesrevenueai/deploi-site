-- Section 7: operations workers (additive)
alter table aides add column if not exists quit_risk boolean not null default false;
alter table aides add column if not exists quit_risk_reason text;
alter table applicants add column if not exists screen_state text not null default 'idle'; -- idle | q1 | q2 | q3 | q4 | complete
alter table clients add column if not exists family_phone text;
alter table shift_offers add column if not exists status text not null default 'pending'; -- pending | sent | accepted | declined | superseded
alter table proposed_actions add column if not exists send_after timestamptz;
alter table proposed_actions add column if not exists agency_name text;
create index if not exists shift_offers_aide_idx on shift_offers (aide_id, created_at desc);
create index if not exists proposed_actions_worker_idx on proposed_actions (worker, status);
