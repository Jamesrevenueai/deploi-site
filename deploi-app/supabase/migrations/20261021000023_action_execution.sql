-- Phase 11 (ops): action execution state machine, delivery tracking, opt-outs, suppression.
-- proposed_actions.status: proposed -> approved -> queued -> attempted -> delivered | failed | unknown
--                          plus skipped | expired | suppressed. Nothing but executeAction / a provider
--                          delivery callback may mark a row delivered.
alter table proposed_actions
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists queued_at timestamptz,
  add column if not exists attempted_at timestamptz,
  add column if not exists attempt_count int not null default 0,
  add column if not exists delivered_at timestamptz,
  add column if not exists delivery_status text,            -- delivered | provider_accepted | failed | unknown
  add column if not exists provider_message_id text,
  add column if not exists failure_reason text,
  add column if not exists simulated boolean not null default false,
  add column if not exists expires_at timestamptz,
  add column if not exists suppressed_reason text,
  add column if not exists idempotency_key text;
create unique index if not exists proposed_actions_idempotency_uq on proposed_actions (idempotency_key) where idempotency_key is not null;
create index if not exists proposed_actions_provider_msg_idx on proposed_actions (provider_message_id) where provider_message_id is not null;
create index if not exists proposed_actions_queued_idx on proposed_actions (status, send_after) where status = 'queued';

-- Every send before this migration went through the mock adapters (no provider keys in any environment),
-- so legacy 'sent' rows are what the new vocabulary calls a simulated delivery.
update proposed_actions set status = 'delivered', simulated = true, delivery_status = 'delivered', delivered_at = coalesce(sent_at, decided_at, now())
  where status = 'sent';

-- Opt-out timestamp beside the consent flag on every textable contact.
alter table aides add column if not exists sms_opt_out_at timestamptz;
alter table applicants add column if not exists sms_opt_out_at timestamptz;
alter table clients add column if not exists sms_opt_out_at timestamptz;

-- Side effects of a simulated send are tagged so they never count as real outcomes (lib/workers/outcomes.ts#isRealOutcome).
alter table shift_offers add column if not exists simulated boolean not null default false;
alter table retention_checkins add column if not exists simulated boolean not null default false;
alter table retention_checkins add column if not exists answered_at timestamptz;
alter table referrals add column if not exists simulated boolean not null default false;
alter table applicants add column if not exists simulated boolean not null default false;

-- Suppress every pending (proposed | approved | queued) action matching a payload key, with a reason.
-- SECURITY DEFINER so a client user's own status change (e.g. hiring an applicant) can retire follow-ups.
create or replace function suppress_pending_actions(p_agency uuid, p_key text, p_value text, p_reason text, p_except_key text default null, p_except_value text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update proposed_actions set status = 'suppressed', suppressed_reason = p_reason, decided_at = coalesce(decided_at, now())
   where agency_id = p_agency and status in ('proposed','approved','queued')
     and payload ->> p_key = p_value
     and (p_except_key is null or coalesce(payload ->> p_except_key, '') <> coalesce(p_except_value, ''));
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function suppress_pending_actions(uuid, text, text, text, text, text) to authenticated, service_role;

-- Replies and completed cases stop obsolete follow-ups, whichever code path changed the record.
create or replace function retire_followups_on_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'shifts' then
    if new.status in ('filled','cancelled','completed') and new.status is distinct from old.status then
      perform suppress_pending_actions(new.agency_id, 'shift_id', new.id::text, 'shift_' || new.status, 'aide_id', new.aide_id::text);
    end if;
  elsif tg_table_name = 'referrals' then
    if new.status in ('declined','lost') and new.status is distinct from old.status then
      perform suppress_pending_actions(new.agency_id, 'referral_id', new.id::text, 'referral_' || new.status);
    elsif new.first_response_at is not null and old.first_response_at is null then
      -- answered by a person: the drafted first reply is obsolete, 7/30-day follow-ups stay
      update proposed_actions set status = 'suppressed', suppressed_reason = 'referral_answered', decided_at = coalesce(decided_at, now())
       where agency_id = new.agency_id and status in ('proposed','approved','queued')
         and payload ->> 'referral_id' = new.id::text and payload ->> 'effect' = 'referral_replied';
    end if;
  elsif tg_table_name = 'applicants' then
    if new.status in ('hired','rejected') and new.status is distinct from old.status then
      perform suppress_pending_actions(new.agency_id, 'applicant_id', new.id::text, 'applicant_' || new.status);
    end if;
  elsif tg_table_name = 'retention_checkins' then
    if new.answered_at is not null and old.answered_at is null then
      perform suppress_pending_actions(new.agency_id, 'checkin_id', new.id::text, 'checkin_answered');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists retire_followups_shifts on shifts;
create trigger retire_followups_shifts after update on shifts for each row execute function retire_followups_on_change();
drop trigger if exists retire_followups_referrals on referrals;
create trigger retire_followups_referrals after update on referrals for each row execute function retire_followups_on_change();
drop trigger if exists retire_followups_applicants on applicants;
create trigger retire_followups_applicants after update on applicants for each row execute function retire_followups_on_change();
drop trigger if exists retire_followups_retention on retention_checkins;
create trigger retire_followups_retention after update on retention_checkins for each row execute function retire_followups_on_change();
