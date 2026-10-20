-- Section 5: assessment engine additions (additive only)
alter table agencies add column if not exists assessment_credit_applied_at timestamptz;
alter table assessments add column if not exists fee_cents int not null default 0;
