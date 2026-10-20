-- Item 6: assessment credit expiry is anchored to the moment the assessment was sold.
alter table prospects add column if not exists assessment_sold_at timestamptz;
alter table agencies add column if not exists credit_expires_at timestamptz;
alter table agencies add column if not exists credit_expired boolean not null default false;

-- Backfill agencies that already carry a credit.
update agencies
   set credit_expires_at = coalesce(assessment_credit_expires_at, now() + interval '60 days')
 where assessment_credit_cents > 0 and credit_expires_at is null;

update prospects p
   set assessment_sold_at = coalesce(p.assessment_sold_at, g.credit_expires_at - interval '60 days')
  from agencies g
 where g.id = p.agency_id and g.credit_expires_at is not null and p.assessment_sold_at is null;
