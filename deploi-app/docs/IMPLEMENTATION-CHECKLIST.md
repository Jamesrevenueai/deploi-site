# Implementation checklist (resume from here)

Release branch `claude/deploi-operating-system` (PR #16). Hotfix branch `claude/hotfix-f02-signup` (PR #17).
Workstream branches `claude/ws-p1` … `claude/ws-p6` are merged into the release branch as they finish.

| # | Item | State | Where |
|---|---|---|---|
| 1 | F-02 production hotfix (trigger + app line + paste SQL + containment runbook) | Done, tested, PR #17 | `docs/HOTFIX-F02.md` |
| 2 | Hotfix merged into the release; rehearsal baseline includes it; a release cannot roll back before later ones | Done | `scripts/launch-migrations.ts`, rehearsals |
| 3 | App rollback safety (the previous app on the new schema) | Done: 298/298 (`main`), 304/304 (`main` + hotfix) | `scripts/test-app-rollback-compat.sh` |
| 4 | Release runbook (owner steps, checks, rollback) | Done | `docs/RELEASE-RUNBOOK.md` |
| 5 | Every agent through the Resolution Engine; Shopify privacy webhooks (F-07) | Done, merged | migration 052 |
| 6 | System mailer, member invites end to end, sign-up → first run, support | Done, merged | migration 053 |
| 7 | Gmail/Outlook inbox reading; Deploi mailbox first-contact policy | Done, merged | migration 054 |
| 8 | Integration hub: reconnect, health job, diagnostics, Office provider metering, webhooks | Done, merged | migration 055 |
| 9 | Billing lifecycle: trials, dunning, plan changes, cancellation, billing page, finance | Done, merged | migration 056 |
| 10 | Operations: alerts, staff ops console, logs, AI-assisted steps with fallback, reliability campaign, smoke check | Done, merged | migration 057 |
| 11 | Integration of 5–10, release set `2026-11-06`, rehearsal, full gates | Done: 956 unit, 63 e2e, three rehearsals, rollback compat | `scripts/test-release-2026-11-06-migrations.sh` |
| 12 | Customer-journey walkthrough in the browser; fix usability defects; e2e for the 10-step journey | Done (4 defects fixed) | `e2e/journey.spec.ts` |
| 13 | Readiness report update | Done | `docs/READINESS-2026-11-05.md` |

## Resume commands

```bash
cd /home/user/deploi-site && git fetch origin && git checkout claude/deploi-operating-system && git pull
cd deploi-app && npx tsc --noEmit && npx vitest run      # local Postgres 16, .env.test
bash scripts/test-release-2026-11-04-migrations.sh && bash scripts/test-release-2026-11-05-migrations.sh && bash scripts/test-release-2026-11-06-migrations.sh
bash scripts/test-app-rollback-compat.sh
```
