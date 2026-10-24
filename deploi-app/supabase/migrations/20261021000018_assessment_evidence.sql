-- Phase 7: assessment evidence layer (additive, idempotent).
-- One jsonb document per assessment holding the evidence period, sample size, source reference, who supplied the
-- numbers, per-input status (measured | owner_reported | assumed) with a source note, missing-data indicators,
-- staff notes and the customer-corrections log ({field, previous, corrected, by, at, note}).
-- Aggregate and redacted evidence only: nothing in here is patient information; `redacted` flags a trace whose
-- step fields were deliberately left blank.
alter table assessments add column if not exists evidence jsonb not null default '{}'::jsonb;
comment on column assessments.evidence is 'Evidence layer: period, sample size, source reference, supplied_by, per-input status/source, missing[], staff_notes, corrections[], redacted. Aggregate only, never patient data.';

-- Phase 8: the ledger (0017) is the truth for credits. A ledger row remembers which staff user recorded the payment
-- so the UI can show who attested a real payment versus who ran the simulated one.
alter table assessment_credits add column if not exists payment_recorded_by uuid;
alter table assessment_credits add column if not exists payment_note text;
