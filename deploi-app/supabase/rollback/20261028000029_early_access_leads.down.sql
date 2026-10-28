-- Rollback of 20261028000029_early_access_leads.sql (function only; leads already captured stay in prospects)
drop function if exists public_create_early_access(text, text, text, text, text[], text, text);
