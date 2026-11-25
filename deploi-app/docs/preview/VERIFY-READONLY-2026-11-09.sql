-- Read-only checks (2026-11-09). Every statement is a SELECT: nothing changes. Supabase's API refuses this
-- session (401), so these are for you to paste; send me the rows (blank out emails if you like).

-- ===== PART 1: deploi-prod (makqaqzlylhckijdbjzi): did STAFF-ADD-OJAE.sql run? ==========================
select key, value, updated_at from settings where key = 'staff_emails';
-- expected: one row whose value lists hello@getdeploi.com, ojae@getdeploi.com, omarjames908@gmail.com

-- ===== PART 2: deploi-preview (bhddgjcefwasdyrrfptc): is the app installed on james-jwtftl1e? ============
select c.platform, c.external_id as shop, c.status, c.scopes, c.installed_at, (cr.connection_id is not null) as has_token, cr.expires_at
from store_connections c left join store_credentials cr on cr.connection_id = c.id
where c.platform = 'shopify' and c.external_id ilike 'james-jwtftl1e%';
-- expected after install: one row, status 'active', has_token true. No row = not installed yet.
