# Data retention and organization deletion

## Retention (lib/platform/retention.ts)

The daily job `platform.retention` (queued by the hourly `/api/cron/jobs`, once per UTC day, idempotent) applies:

| Data | Kept for | What happens after | Org may adjust | Env (default) |
|---|---|---|---|---|
| Outbound email content (`email_messages`, finished: accepted, failed, cancelled, unknown) | 365 days | encrypted content erased; the record (who, when, status, content hash) stays | yes, 1-730 days | `RETENTION_EMAIL_BODIES_DAYS` |
| Inbound email raw content, authentication results, attachment metadata (`email_inbound`) | 30 days | erased; the thread and case keep what was extracted | yes, 1-730 days | `RETENTION_INBOUND_RAW_DAYS` |
| Provider delivery log (`inbound_webhook_events`) | 30 days | deleted | no | `RETENTION_INBOUND_RAW_DAYS` |
| Finished job rows (`jobs`) | 90 days | deleted (queued and running jobs are never touched) | yes, 1-730 days | `RETENTION_JOBS_DAYS` |
| Rate-limit windows (`rate_limits`) | 1 day after expiry | deleted | no | `RETENTION_RATE_LIMIT_DAYS` |
| Webhook receipts (`webhook_receipts`) | 90 days | deleted | no | `RETENTION_WEBHOOK_RECEIPTS_DAYS` |
| Case history (`cases`, `case_events`, `case_links`) | while the organization exists | deleted with the organization | no | - |
| Everything else of an organization | while the organization exists | deleted with the organization | no | - |

Owners and admins adjust their organization's periods with `POST /api/store/settings/retention`
(`{ emailBodies?, inboundRaw?, jobs? }`, days or `null` for the default); any member reads them with `GET`.
The job's last run is in `/api/health` (`retention.lastRunAt`, `lagHours`).

## Organization deletion (lib/platform/deletion.ts)

1. An **owner** requests deletion (`POST /api/store/settings/deletion` `{ action: 'request' }`). A 7-day
   cooling-off period starts (`ORG_DELETION_COOLING_OFF_DAYS`, 1-30). Nothing is deleted during it; an owner can
   cancel (`{ action: 'cancel' }`). Admins, members, viewers, embedded Shopify sessions and Deploi staff cannot.
2. After it, the `platform.deletion` job:
   - stops all agents of the organization;
   - revokes provider access: email accounts at the provider where it supports revocation; WooCommerce stores
     are disconnected (our webhooks removed from the store); HubSpot, Google Calendar and Shopify have no revoke
     call in Deploi, so their tokens are deleted with the data (Shopify ends access and billing on uninstall);
   - cancels the Stripe subscription at once;
   - deletes every row of every table that carries the organization's id, except the kept records below;
   - deletes each member's sign-in account (or, where the database role may not, anonymizes and detaches the
     profile and reports the count for an operator to finish with the Supabase admin API);
   - keeps the organization row as an anonymized tombstone (`Deleted organization`, `deleted_at`);
   - writes a final `org.deleted` entry to the audit trail **outside** the organization (global chain).
   A failure marks the request failed with the reason; the next run retries (up to 10 attempts). The lag of
   overdue deletions is in `/api/health` (`deletion.overdue`, `oldestOverdueHours`).

### Kept after deletion, and why

| Record | Why | How long (owner to confirm with counsel) |
|---|---|---|
| `legal_acceptances` (who accepted which terms version, when, from where) | evidence of the contract and the AI agent authorization terms | 6 years after deletion (limitation period for contract claims) |
| `billing_customers`, `billing_subscriptions`, `billing_events` | tax and accounting records | as tax law requires (typically 6-7 years) |
| `engine_audit` (tamper-evident; secrets scrubbed) and `audit_events` (ids only, no content) | security record of what agents and people did; the hash chain must stay verifiable | 2 years after deletion |
| `org_deletion_requests` | proof that and when the deletion was carried out | with the billing records |
| `agencies` row (anonymized tombstone) | the kept records point at it | with the kept records |

Purging the kept records at the end of those periods is an operator task today (not automated).
