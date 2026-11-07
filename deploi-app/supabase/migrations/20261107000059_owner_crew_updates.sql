-- =============================================================================
-- Owner and crew updates (lib/notify):
--   1. notify_preferences  per person in the organization: which channels an update uses (email on by default,
--                          text and voice note off), the phone number for text/voice, and a daily digest option
--   2. owner_updates       every update an agent sent the owner (one row per update, recipient and channel):
--                          one update per (organization, dedupe key); status sent / held / failed / queued
--   3. notify_outbox       text messages and voice notes. With NOTIFY_SMS_PROVIDER=simulated (the default) the
--                          message is stored here and nothing leaves Deploi (docs/NOTIFY-CHANNELS.md)
--   4. crew_members        the business's own crew (packers, warehouse, field crew): name, role, email, phone
--   5. crew_jobs           jobs given to a crew member for a day: address, details, photos, status
--   6. crew_messages       every message to and from a crew member (job lists out, "done" replies in)
--   7. crew_job_links      one-time "mark done" links in a crew message (the token is signed, never stored)
--   8. morning_reports     one morning report per organization per day
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes
-- through server functions (service role).
-- Rollback: supabase/rollback/20261107000059_owner_crew_updates.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. preferences
create table if not exists notify_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  email_on boolean not null default true,
  text_on boolean not null default false,
  voice_on boolean not null default false,
  -- E.164, for text messages and voice notes
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- 'daily': routine updates wait for the morning report; updates that need the owner still go at once
  digest text not null default 'off' check (digest in ('off', 'daily')),
  updated_at timestamptz not null default now(),
  unique (org_id, profile_id)
);

-- ---------------------------------------------------------------- 2. owner updates
create table if not exists owner_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  kind text not null default 'update' check (kind in ('update', 'action_needed')),
  agent_key text not null check (length(agent_key) between 1 and 80),
  agent_name text not null check (length(agent_name) between 1 and 120),
  case_ref text check (length(case_ref) <= 40),
  headline text not null check (length(headline) between 1 and 300),
  severity text not null default 'info' check (severity in ('info', 'action', 'warning')),
  -- { whatHappened, whatIDid[], proof[], detailsPath, hasUndo }
  content jsonb not null default '{}'::jsonb,
  recipient_profile_id uuid,
  -- the address or phone number it went to
  recipient text check (length(recipient) <= 320),
  channel text not null check (channel in ('email', 'text', 'voice', 'digest')),
  status text not null check (status in ('sent', 'held', 'failed', 'queued', 'skipped')),
  status_reason text check (length(status_reason) <= 500),
  system_email_id uuid,
  outbox_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, dedupe_key, channel, recipient)
);
create index if not exists owner_updates_org_recent on owner_updates (org_id, created_at desc);

-- ---------------------------------------------------------------- 3. text and voice outbox
create table if not exists notify_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  audience text not null check (audience in ('owner', 'crew')),
  -- the profile (owner) or crew member it is for
  recipient_ref uuid,
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{6,14}$'),
  channel text not null check (channel in ('text', 'voice')),
  provider text not null default 'simulated' check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  body text not null check (length(body) <= 4000),
  -- a voice note: what the voice says, word for word
  transcript text check (length(transcript) <= 6000),
  status text not null check (status in ('simulated', 'held', 'sent', 'failed')),
  status_reason text check (length(status_reason) <= 500),
  provider_message_id text check (length(provider_message_id) <= 120),
  created_at timestamptz not null default now(),
  unique (org_id, dedupe_key, channel)
);
create index if not exists notify_outbox_org_recent on notify_outbox (org_id, created_at desc);

-- ---------------------------------------------------------------- 4. crew
create table if not exists crew_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  role text not null default 'other' check (role in ('packer', 'warehouse', 'field', 'other')),
  email text check (email is null or (length(email) <= 320 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  channels text[] not null default array['email']::text[] check (channels <@ array['email', 'text']::text[]),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crew_members_org on crew_members (org_id, active, name);

create table if not exists crew_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  job_ref text not null check (length(job_ref) between 1 and 60),
  crew_member_id uuid references crew_members(id) on delete set null,
  job_date date not null default current_date,
  address text check (length(address) <= 500),
  details text check (length(details) <= 4000),
  photos text[] not null default '{}'::text[] check (cardinality(photos) <= 20),
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'in_progress', 'done', 'cancelled')),
  -- which agent (and case) gave the job
  source_agent text check (length(source_agent) <= 80),
  source_case_ref text check (length(source_case_ref) <= 40),
  done_at timestamptz,
  done_via text check (done_via in ('link', 'reply', 'owner')),
  -- what the crew member was last told (to say what changed since)
  last_sent jsonb,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, job_ref)
);
create index if not exists crew_jobs_day on crew_jobs (org_id, job_date, crew_member_id);

create table if not exists crew_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  crew_member_id uuid references crew_members(id) on delete set null,
  direction text not null default 'out' check (direction in ('out', 'in')),
  channel text not null check (channel in ('email', 'text')),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  job_refs text[] not null default '{}'::text[],
  subject text check (length(subject) <= 300),
  body text not null check (length(body) <= 8000),
  status text not null check (status in ('sent', 'held', 'failed', 'simulated', 'received', 'skipped')),
  status_reason text check (length(status_reason) <= 500),
  system_email_id uuid,
  outbox_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, dedupe_key, channel, direction)
);
create index if not exists crew_messages_member on crew_messages (org_id, crew_member_id, created_at desc);

create table if not exists crew_job_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  job_id uuid not null references crew_jobs(id) on delete cascade,
  crew_member_id uuid references crew_members(id) on delete set null,
  message_key text check (length(message_key) <= 200),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists crew_job_links_job on crew_job_links (job_id);

-- ---------------------------------------------------------------- 8. morning reports
create table if not exists morning_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  report_date date not null,
  period_start timestamptz not null,
  status text not null default 'prepared' check (status in ('prepared', 'sent', 'held', 'failed', 'skipped')),
  status_reason text check (length(status_reason) <= 500),
  facts jsonb not null default '{}'::jsonb,
  sent_to_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, report_date)
);

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['notify_preferences', 'owner_updates', 'notify_outbox', 'crew_members', 'crew_jobs', 'crew_messages', 'crew_job_links', 'morning_reports'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
