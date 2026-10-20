# Paths behind the BAA gate

`assertBaaSigned(db, agencyId)` runs before any row is written on:

| Path | Where the gate runs |
|---|---|
| Applicant webhook | `app/api/webhooks/applicant/route.ts` (403 JSON) |
| Referral inbox (Resend inbound) | `app/api/webhooks/resend-inbound/route.ts` (403 JSON) |
| Manual referral form | `logReferral` in `app/staff/actions/actions.ts` (redirect `?error=baa-not-signed`) |
| Applicant CSV import | `importApplicants` in `app/staff/actions/actions.ts` |
| EVV / scheduler / claim CSV import | `stageImport` and `commitImport` in `app/staff/evv/import/actions.ts` |

Not gated on purpose: assessment traces, leak inputs, report generation, the public lead API (sales data, not client data).

Paths named in the brief that do not exist yet (gate them with the same helper when they are built):
roster upload (no aides/clients CSV import exists), capacity-rules editor (rules are read by workers but no UI writes them), referral inbox setup screen.
