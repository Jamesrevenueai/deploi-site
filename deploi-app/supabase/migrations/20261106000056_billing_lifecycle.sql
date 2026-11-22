-- Billing lifecycle (P5): trials, payment failures and dunning, plan changes, cancellation with a reason,
-- and the billing notices queued for the owner. Stripe stays authoritative for money: these tables record
-- what Stripe confirmed (webhooks) and what the app asked Stripe to do, never a price the app invented.

-- ---------------------------------------------------------------- subscriptions: what Stripe confirmed
alter table billing_subscriptions add column if not exists plan_key text references plans(key) on delete set null;
alter table billing_subscriptions add column if not exists price_external_id text check (price_external_id is null or price_external_id ~ '^price_[A-Za-z0-9]+$');
alter table billing_subscriptions add column if not exists item_external_id text check (item_external_id is null or item_external_id ~ '^si_[A-Za-z0-9]+$');
alter table billing_subscriptions add column if not exists trial_start timestamptz;
-- cancellation: requested by the owner (at period end) and confirmed by Stripe; ended_at when it actually ended
alter table billing_subscriptions add column if not exists cancel_reason text check (cancel_reason is null or cancel_reason in
  ('too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'));
alter table billing_subscriptions add column if not exists cancel_comment text check (cancel_comment is null or length(cancel_comment) <= 500);
alter table billing_subscriptions add column if not exists cancel_requested_at timestamptz;
alter table billing_subscriptions add column if not exists canceled_at timestamptz;
alter table billing_subscriptions add column if not exists ended_at timestamptz;
-- a downgrade waiting for the period end (a Stripe subscription schedule)
alter table billing_subscriptions add column if not exists schedule_external_id text check (schedule_external_id is null or schedule_external_id ~ '^sub_sched_[A-Za-z0-9]+$');
alter table billing_subscriptions add column if not exists pending_plan_key text references plans(key) on delete set null;
alter table billing_subscriptions add column if not exists pending_change_at timestamptz;
-- invoice events are ordered separately from subscription events (an older invoice event never undoes a newer one)
alter table billing_subscriptions add column if not exists last_invoice_event_at timestamptz;

-- one trial per e-mail address across organizations: a normalized SHA-256 of the billing e-mail, never the address
alter table billing_customers add column if not exists email_hash text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------- trials: one per organization, customer and e-mail
create table if not exists billing_trials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references agencies(id) on delete cascade,
  plan_key text references plans(key) on delete set null,
  customer_external_id text,
  subscription_external_id text,
  email_hash text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  ends_at timestamptz,
  -- trialing: running; converted: the first paid invoice after the trial; lapsed: ended without payment; canceled: cancelled during the trial
  outcome text not null default 'trialing' check (outcome in ('trialing', 'converted', 'lapsed', 'canceled')),
  converted_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists billing_trials_customer on billing_trials (customer_external_id) where customer_external_id is not null;
create unique index if not exists billing_trials_email on billing_trials (email_hash) where email_hash is not null;

-- ---------------------------------------------------------------- payment failures (dunning); Stripe's retry schedule is authoritative
create table if not exists billing_payment_failures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  subscription_external_id text,
  invoice_external_id text not null check (invoice_external_id ~ '^in_[A-Za-z0-9_]+$'),
  attempt_count int not null default 1 check (attempt_count >= 0),
  amount_due_cents bigint check (amount_due_cents is null or amount_due_cents >= 0),
  currency text check (currency is null or currency ~ '^[a-z]{3}$'),
  hosted_invoice_url text check (hosted_invoice_url is null or hosted_invoice_url ~ '^https://'),
  -- when Stripe will retry (null: no more retries)
  next_attempt_at timestamptz,
  failure_message text check (failure_message is null or length(failure_message) <= 300),
  failed_at timestamptz not null default now(),
  recovered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (invoice_external_id, attempt_count)
);
create index if not exists billing_payment_failures_org on billing_payment_failures (org_id, failed_at desc);

-- ---------------------------------------------------------------- plan changes: previewed, requested, then applied when Stripe confirms
create table if not exists billing_plan_changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  subscription_external_id text not null,
  from_plan_key text references plans(key) on delete set null,
  to_plan_key text not null references plans(key) on delete cascade,
  direction text not null check (direction in ('upgrade', 'downgrade')),
  -- previewed: shown to the owner; requested: sent to Stripe (upgrade); scheduled: at period end (downgrade);
  -- applied: Stripe confirmed (webhook); cancelled / expired / failed
  status text not null default 'previewed' check (status in ('previewed', 'requested', 'scheduled', 'applied', 'cancelled', 'expired', 'failed')),
  proration_date timestamptz,
  -- Stripe's preview invoice, summarized: { amountDueCents, currency, lines: [{ description, amountCents, proration }] }
  preview jsonb not null default '{}'::jsonb check (jsonb_typeof(preview) = 'object'),
  effective_at timestamptz,
  schedule_external_id text,
  requested_by text check (length(requested_by) <= 160),
  error text check (length(error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists billing_plan_changes_org on billing_plan_changes (org_id, created_at desc);

-- ---------------------------------------------------------------- notices to the owner (trial ending, payment failed, ...)
-- Queued inside the webhook transaction and delivered after it commits (lib/billing/notify.ts). The dedupe key
-- makes a redelivered or replayed event queue nothing new.
create table if not exists billing_notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  kind text not null check (kind in ('trial_ending', 'payment_failed', 'payment_recovered', 'subscription_canceled', 'cancel_scheduled', 'plan_changed', 'read_only')),
  dedupe_key text not null unique check (length(dedupe_key) <= 200),
  recipient text check (recipient is null or length(recipient) <= 254),
  subject text not null check (length(subject) <= 200),
  body text not null check (length(body) <= 4000),
  link text check (link is null or link ~ '^https?://'),
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts int not null default 0,
  error text check (length(error) <= 300),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists billing_notices_pending on billing_notices (created_at) where status = 'pending';

-- ---------------------------------------------------------------- RLS: the organization reads its own; staff read all; only the server writes
do $$
declare t text;
begin
  foreach t in array array['billing_trials', 'billing_payment_failures', 'billing_plan_changes', 'billing_notices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['billing_trials', 'billing_plan_changes'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;
