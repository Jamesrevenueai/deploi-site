# Implementation checklist (resume from here)

Release branch `claude/deploi-operating-system` (PR #16). Hotfix branch `claude/hotfix-f02-signup` (PR #17).
Workstream branches `claude/ws-p1` … `claude/ws-p6` are merged into the release branch as they finish.

| # | Item | State | Where |
|---|---|---|---|
| 1 | F-02 production hotfix (trigger + app line + paste SQL + containment runbook) | Done, tested, PR #17 | `docs/HOTFIX-F02.md` |
| 2 | Hotfix merged into the release; rehearsal baseline includes it; a release cannot roll back before later ones | Done | `scripts/launch-migrations.ts`, rehearsals |
| 3 | App rollback safety (the previous app on the new schema) | Done: 298/298 (`main`), 304/304 (`main` + hotfix) | `scripts/test-app-rollback-compat.sh` |
| 4 | Release runbook (owner steps, checks, rollback) | Done | `docs/RELEASE-RUNBOOK.md` |
| 5 | Every agent through the Resolution Engine; Shopify privacy webhooks (F-07) | In progress (P1) | migration 052 |
| 6 | System mailer, member invites end to end, sign-up → first run, support | In progress (P2) | migration 053 |
| 7 | Gmail/Outlook inbox reading; Deploi mailbox first-contact policy | In progress (P3) | migration 054 |
| 8 | Integration hub: reconnect, health job, diagnostics, Office provider metering, webhooks | In progress (P4) | migration 055 |
| 9 | Billing lifecycle: trials, dunning, plan changes, cancellation, billing page, finance | In progress (P5) | migration 056 |
| 10 | Operations: alerts, staff ops console, logs, AI-assisted steps with fallback, reliability campaign, smoke check | In progress (P6) | migration 057 |
| 11 | Integration of 5–10, release set `2026-11-06`, rehearsal, full gates | To do | — |
| 12 | Customer-journey walkthrough in the browser; fix usability defects; e2e for the 10-step journey | To do | — |
| 13 | Readiness report update | To do | — |

## Resume commands

```bash
cd /home/user/deploi-site && git fetch origin && git checkout claude/deploi-operating-system && git pull
cd deploi-app && npx tsc --noEmit && npx vitest run      # local Postgres 16, .env.test
bash scripts/test-release-2026-11-04-migrations.sh && bash scripts/test-release-2026-11-05-migrations.sh
bash scripts/test-app-rollback-compat.sh
```
