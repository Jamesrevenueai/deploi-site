#!/usr/bin/env bash
# PHASE B, step 2: apply the 7 launch migrations to production, with gates. Run ONLY after Phase A passed and you approved.
#
#   export PROD_DATABASE_URL='postgres://...'
#   bash scripts/prod/phase-b.sh <project-ref> ./phase-b-$(date -u +%F)
# Paste <out>/PASTE-THIS.txt back to the chat. If any GATE line says FAIL, nothing further runs and the script rolls the launch
# migrations back (only if they were applied by this run and no new data was written to them).
. "$(dirname "$0")/lib.sh"
URL=${PROD_DATABASE_URL:?set PROD_DATABASE_URL first}; REF=${1:?usage: phase-b.sh <project-ref> <out-dir>}; OUT=${2:?out dir}
need psql "PostgreSQL client"; need npx "Node.js 20+"
cd "$(dirname "$0")/../.."; mkdir -p "$OUT"
[[ "${DEPLOI_RUNBOOK_TEST:-}" == 1 || "$(project_ref "$URL")" == "$REF" ]] || { echo "GATE FAIL: the URL's project ref ($(project_ref "$URL")) is not $REF"; exit 1; }
[[ -d node_modules/.bin ]] || npm ci --no-audit --no-fund >/dev/null
SURL=$(session_url "$URL"); TS="npx tsx scripts/launch-migrations.ts"; C="--confirm-production=$REF"
EXPECTED_NEW="agent_policies agent_runs agent_tasks agents app_subscriptions approvals beta_invites competitor_checks competitor_findings competitor_products competitor_sources email_accounts email_credentials email_inbound email_messages email_oauth_states engine_audit executions inbound_webhook_events issues merchant_rules proposals reference_rows reference_sources scans store_access store_connections store_credentials synthetic_email_state synthetic_store_state webhook_receipts weekly_summaries"
count_kept() { psql -tA "$SURL" -c "select (select count(*) from agencies)||'/'||(select count(*) from profiles)||'/'||(select count(*) from prospects)||'/'||(select count(*) from audit_events)"; }
carerows() { psql -tA "$SURL" -c "select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', tablename), false, true, '')))[1]::text::bigint),0) from pg_tables where schemaname='public' and tablename in ('assessments','trace_steps','clients','aides','authorizations','shifts','shift_offers','visits','evv_exceptions','referrals','applicants','proposed_actions','retention_checkins','worker_runs','evv_imports','assessment_credits','assessment_credit_applications','engagements','engagement_transitions','onboarding_items','pilots','pilot_measurements','job_runs','imports','visit_revisions','evv_rule_sets','internal_rates','labor_entries','cost_entries','revenue_entries','service_tickets','website_engagements','website_labor','website_transitions')"; }
{
echo "PHASE B REPORT  $(date -u +%FT%TZ)  (commit $(git rev-parse --short HEAD))"; hr
echo "BEFORE: kept rows (agencies/profiles/prospects/audit_events) = $(count_kept); care-table rows = $(carerows)"
BEFORE_KEPT=$(count_kept); BEFORE_CARE=$(carerows)
echo "-- status before"; $TS status --db "$SURL" $C
echo "-- dry run (one transaction, rolled back)"; $TS dry-run --db "$SURL" $C || { echo "GATE FAIL: dry run failed; nothing was changed"; exit 1; }
echo "-- apply"; if ! $TS apply --db "$SURL" $C; then echo "GATE FAIL: apply failed (each migration is its own transaction; see status below)"; $TS status --db "$SURL" $C; exit 1; fi
echo "-- status after"; $TS status --db "$SURL" $C
FAIL=0
LEDGER=$(psql -tA "$SURL" -c "select count(*) from _migrations where name in ('20261028000028_merchant_engine.sql','20261028000029_early_access_leads.sql','20261028000030_agents.sql','20261028000031_email.sql','20261028000032_agent_platform.sql','20261029000032_store_access.sql','20261029000033_competitor_watch.sql')")
echo "GATE ledger: $LEDGER of 7 launch migrations recorded"; [[ "$LEDGER" == "7" ]] || { echo "GATE FAIL: ledger"; FAIL=1; }
MISSING=""; for t in $EXPECTED_NEW; do [[ "$(psql -tA "$SURL" -c "select to_regclass('public.$t') is not null")" == "t" ]] || MISSING="$MISSING $t"; done
echo "GATE tables: $(( $(wc -w <<<"$EXPECTED_NEW") - $(wc -w <<<"$MISSING") )) of $(wc -w <<<"$EXPECTED_NEW") expected new tables present"; [[ -z "$MISSING" ]] || { echo "GATE FAIL: missing:$MISSING"; FAIL=1; }
echo "GATE kept rows: before $BEFORE_KEPT, after $(count_kept)  (audit_events may grow by the migration's own audit rows)"
[[ "$(count_kept | cut -d/ -f1-3)" == "$(cut -d/ -f1-3 <<<"$BEFORE_KEPT")" ]] || { echo "GATE FAIL: agencies/profiles/prospects changed"; FAIL=1; }
echo "GATE care rows: before $BEFORE_CARE, after $(carerows)"; [[ "$(carerows)" == "$BEFORE_CARE" ]] || { echo "GATE FAIL: care rows changed"; FAIL=1; }
echo "GATE early access function: $(psql -tA "$SURL" -c "select count(*) from pg_proc where proname='public_create_early_access'") present; prospects columns: $(psql -tA "$SURL" -c "select count(*) from information_schema.columns where table_name='prospects' and column_name in ('service_interest','tags','website_url','website_goal','website_details')") of 5"
if [[ $FAIL == 1 ]]; then echo "RESULT: FAIL. Rolling the launch migrations back (refuses if the new tables already hold rows)."; $TS rollback --db "$SURL" $C || echo "ROLLBACK REFUSED OR FAILED: paste this to the chat before doing anything else"; exit 1; fi
echo "RESULT: PASS"
} 2>&1 | tee "$OUT/PASTE-THIS.txt"
