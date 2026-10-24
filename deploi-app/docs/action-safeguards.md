# Action safeguards

Workers only propose. No worker, cron, webhook or model makes a clinical, employment or billing
decision: every outbound message is a `proposed_actions` row that a staff user approves (or that an
agency has explicitly opted into auto-send for, per worker, default OFF), and every EVV finding is
advisory. Hiring, rejecting, holding a claim, billing a visit and anything about care stay with people.

## States

`proposed_actions.status` moves through

```
proposed (drafted) -> approved -> queued -> attempted -> delivered | failed | unknown
                                          \
plus: skipped (staff), expired (deadline passed), suppressed (obsolete or opted out)
```

| State | Set by | Meaning |
| --- | --- | --- |
| proposed | worker / webhook handler | Drafted. `hold_reason` explains why an approval was refused (no SMS consent). |
| approved | `approveAction` (staff, or auto-send on the agency's behalf) | Decision recorded (`approved_at`, `approved_by`). Nothing sent yet. |
| queued | `executeAction` | Outside the agency's contact window; `send_after` = next window start. The crons drain it. |
| attempted | `executeAction` | Marked **before** the adapter call (`attempted_at`, `attempt_count`, `idempotency_key`). A real provider accepted it: `delivery_status = provider_accepted`. |
| delivered | mock adapter (`simulated = true`), task hand-over, or a provider delivery callback | Confirmed. Only these three paths may set it. |
| failed | adapter error, no reachable recipient, or a failed/undelivered/bounced callback | `failure_reason` set. Retryable. |
| unknown | `markUnknownDeliveries` | Provider accepted, no callback after `ACTION_DELIVERY_UNKNOWN_AFTER_MIN` (120). Visible under "Delivery unknown". Retryable. |
| skipped | staff | Declined. |
| expired | `executeAction` | `expires_at` passed (shift offers at shift start, referral first replies after 72 h, others per `ACTION_EXPIRY_HOURS_DEFAULT`). |
| suppressed | opt-out, triggers, webhook handlers | `suppressed_reason`: opt_out, shift_filled, shift_cancelled, referral_answered, referral_closed, referrer_replied, applicant_replied, applicant_hired, applicant_rejected, checkin_answered. |

## Rules

- **Approval and execution are separate.** `approveAction` only records the decision. `executeAction`
  (called right after approval by the UI, by auto-send, by a retry and by the cron drain) re-checks, in order:
  idempotency, expiry, SMS consent, contact window, recipient, then calls the adapter.
- **Provider acceptance is not delivery.** A non-mock adapter result leaves the row `attempted` with
  `delivery_status = provider_accepted` until the Twilio status callback (`/api/webhooks/twilio/status`)
  or the Resend `email.delivered` / `email.bounced` event confirms it. With no callback the row becomes `unknown`.
- **Simulated sends are labelled everywhere.** A mock-adapter send is `delivered` + `simulated = true`:
  a "simulated" badge on cards, a count on the Actions page, `simulatedReportLine()` for reports, and a
  column wherever actions are exported. `isRealOutcome(row)` (`lib/workers/outcomes.ts`) is false for them.
  The side effect of a simulated send is still applied so demo flows continue, but the resulting row is
  tagged `simulated = true` (columns on `shift_offers`, `retention_checkins`, `referrals`, `applicants`);
  metrics must filter with `isRealOutcome`.
- **Retries are idempotent.** `idempotency_key` = action id + attempt scope. A row that is `attempted`
  or `delivered`, or that already carries the key, is a no-op (`mockSmsOutbox` length unchanged).
  Duplicate cron runs are skipped by `withJobLock(db, key, agency-local date)` on both crons; `runWorker`
  still dedupes proposals by `dedupe_key`.
- **Opt-outs.** STOP / UNSUBSCRIBE / CANCEL / END / QUIT from a number sets `sms_consent = false` and
  `sms_opt_out_at` on every matching aide, applicant or client and suppresses their pending SMS (`opt_out`).
- **Replies and completed cases stop follow-ups.** Triggers in migration 0023 suppress pending actions
  when a shift is filled/cancelled, a referral is answered by a person or declined/lost, an applicant is
  hired/rejected, or a check-in is answered; the webhook handlers do the same in process.
- **Contact windows** use the agency timezone and `capacity_rules.hours` (default 08:00–20:00 local);
  SMS outside the window is queued, never sent.
- **Provider webhooks fail closed.** In production a missing secret is a 503 ("webhook secret not configured");
  whenever a secret is present the signature or bearer is verified (`lib/workers/webhook-guard.ts`).
- **Urgent or out-of-scope texts** (emergency, 911, fall, hospital, injured, chest pain, unsafe, or anything
  no handler recognizes) create a task for the admin and get exactly one line back: "A person will follow up."
  Never a generated answer. (If a service-ticket table exists, it is not used here; the task is the record.)
- **Tenant and role enforcement.** Approve, execute and retry run behind `requireRole('staff')` and first
  resolve the action as the signed-in user under RLS; the send itself runs with the service role and the
  staff user's id as actor.

## Configuration (read in `lib/workers/config.ts`)

`ACTION_DELIVERY_UNKNOWN_AFTER_MIN` (120), `ACTION_EXPIRY_HOURS_DEFAULT` (0 = never),
`ACTION_REFERRAL_REPLY_EXPIRY_HOURS` (72), `CONTACT_WINDOW_DEFAULT` (`08:00-20:00`), `URGENT_KEYWORDS`
(comma list). Secrets: `TWILIO_AUTH_TOKEN`, `RESEND_WEBHOOK_SECRET`, `SMARTLEAD_WEBHOOK_SECRET`,
`APPLICANT_WEBHOOK_SECRET`.
