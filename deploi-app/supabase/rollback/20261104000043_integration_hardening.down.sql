-- Rollback of 20261104000043_integration_hardening.sql. The revoked privileges are not restored (they were
-- default grants no user session used; re-granting would re-open ciphertext columns). The task_key check
-- is left as is: narrowing it would fail on existing 'human_reply' or 'office' rows, and migrations 39 and
-- 40 own those values (their own rollbacks remove them).
select 1;
