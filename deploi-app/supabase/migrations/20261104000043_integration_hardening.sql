-- =============================================================================
-- Integration hardening across the 2026-11-04 workstreams. Tables that only server code (service role)
-- reads had RLS on and no policy (so a session already read zero rows), but default privileges still
-- granted anon/authenticated SELECT and writes on them, including WooCommerce key and webhook-secret
-- ciphertext. Close those privileges outright (defence in depth). Nothing in the app reads them as a user.
-- Rollback: supabase/rollback/20261104000043_integration_hardening.down.sql
-- =============================================================================
do $$ declare t text; begin
  foreach t in array array['woo_auth_states','woo_connections','office_credentials','office_oauth_states','office_org_locks','office_synthetic_state','engine_audit_chain'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on %I from anon, authenticated', t);
      execute format('grant all on %I to service_role', t);
    end if;
  end loop;
end $$;

-- email_messages.task_key: migrations 39 (customer inbox, 'human_reply') and 40 (Deploi Office, 'office')
-- were written in parallel and each redefined the same check; 40 ran last and dropped 'human_reply', so a
-- person's reply from the customer inbox failed to save. One check with every task.
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check
  check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'human_reply', 'office'));
