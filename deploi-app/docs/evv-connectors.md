# EVV connectors

Status: **thin MVP**. Every vendor runs on CSV export today. Live connectors (`lib/evv/connectors/*.ts`)
throw `NotImplemented` and start after `/staff/conversations` shows 10 held owner conversations.
What follows is what each real connector needs, as far as we know; verify against current vendor docs
before quoting a client.

## What we map (every vendor)

| Field | Notes |
| --- | --- |
| `vendor_visit_key` | Vendor's visit id. Upsert key per agency. Required. |
| `client_name` / `client_ref` | Matched to `clients` by "First Last" or "Last, First" within the agency; else left null (auth rules skip). |
| `employee_name` | Matched to `aides` the same way. |
| `service_code` | HCPCS/procedure code (T1019, S5125, G0156, T2025 …). Required. |
| `scheduled_start/end`, `actual_start/end` | Wall-clock in the agency timezone unless the export carries an offset. |
| `verification_status` | Verified / Unverified / Exception. |
| `gps_in_flag`, `gps_out_flag` | true = inside geofence, false = outside, null = missing. |
| `units` | If absent: actual duration ÷ 15 min, else scheduled. |

Rules (`lib/evv/rules.ts`): missing clock-in, missing clock-out, duration outside ± tolerance,
GPS outside geofence, unverified past the state's correction window, service vs. authorization
mismatch, units exceeding remaining authorization. Correction windows: `EVV_CORRECTION_WINDOWS` (Ohio 60).

## Ohio context

Ohio Medicaid's EVV aggregator is operated by Sandata. Agencies either use Sandata's own EVV
("state-provided") or an alternate EVV vendor that exports to the aggregator via the Alt-EVV
interface. For aggregator-side status (visit accepted / rejected / exception), the agency's
Sandata aggregator portal is the source of truth; most vendors expose only their own visit state.
The 60-day figure is a working default for the visit-correction window; confirm the current ODM
policy and the specific program (ODA PASSPORT, ODM waivers, DODD) before relying on it.

## Sandata (first)

- **Today:** Visit Maintenance / visit export CSV from the Sandata EVV portal. Preset columns:
  VisitKey, ClientName, ClientID, EmployeeName, EmployeeID, Service, ScheduleStartTime,
  ScheduleEndTime, CallInTime, CallOutTime, VisitStatus, CallInGPS, CallOutGPS, Units. Column
  names vary by state configuration; the import form lets staff remap.
- **Live connector needs:** Sandata EVV API access for the agency (provider-level credentials
  issued through Sandata / the state program; typically a username/password or OAuth client plus
  an account/business-entity id), the visit and client endpoints, and a polling schedule
  (`fetchVisits(since)`). Sandata's APIs are generally documented under its Alt-EVV / Open EVV
  specification; the exact endpoints for *reading* visits back differ from the Alt-EVV *submit*
  interface and must be confirmed with Sandata. Expect rate limits per account and 24-hour
  lag on aggregator status.
- **Alternative:** scheduled SFTP/email export from the agency, dropped into the CSV importer.

## AlayaCare (next)

- **Today:** export visits (Scheduling → Visits report) to CSV; generic mapper auto-detects
  "Visit ID", "Client", "Caregiver/Employee", "Service", "Scheduled/Actual Start/End", "EVV status".
- **Live connector needs:** AlayaCare REST API (tenant subdomain, API user with the visits/clients
  scopes, OAuth2 or basic token depending on tenant setup); endpoints for visits, clients,
  employees and EVV clock events. Partner/integration enablement is done by AlayaCare on the
  tenant. Rate limits apply per tenant; paginate by updated-at.

## HHAeXchange (next)

- **Today:** Visit/EVV reports exported to CSV from the agency portal; generic mapper.
- **Live connector needs:** HHAeXchange partner/integration API access (an integration agreement
  with HHAX, per-agency credentials, and the visit/EVV endpoints). Many states use HHAX as the
  state aggregator, so visit confirmation data may only be available via the agency's portal
  export rather than a public API; confirm per state and per agency contract.

## WellSky Personal Care (next)

- **Today:** CSV export of visits/shifts (formerly ClearCare) via the reports module; generic mapper.
- **Live connector needs:** WellSky Personal Care API access through the WellSky partner program
  (agency authorizes the integration; API key per agency), endpoints for shifts/visits, clients,
  caregivers and telephony/GPS clock events. Expect a vetting process before credentials are issued.

## Adding a live connector

1. Implement `fetchVisits(since)` in `lib/evv/connectors/<vendor>.ts` returning `VisitInput[]`.
2. Reuse `ingestVisits()` so rules, windows, audit and tenancy are identical to the CSV path.
3. Store credentials per agency in an encrypted settings row (never in env for a multi-tenant deploy).
4. Add a cron endpoint under `app/api/cron/` that runs the pull per agency with `auto_send` semantics
   (dry-run first, staff approval, then scheduled).
