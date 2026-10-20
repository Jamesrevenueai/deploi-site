-- Item 7: SMS consent on every textable contact; proposed actions can be held with a reason.
alter table aides add column if not exists sms_consent boolean not null default false;
alter table aides add column if not exists sms_consent_at timestamptz;
alter table applicants add column if not exists sms_consent boolean not null default false;
alter table applicants add column if not exists sms_consent_at timestamptz;
alter table clients add column if not exists sms_consent boolean not null default false;
alter table clients add column if not exists sms_consent_at timestamptz;
alter table proposed_actions add column if not exists hold_reason text;
