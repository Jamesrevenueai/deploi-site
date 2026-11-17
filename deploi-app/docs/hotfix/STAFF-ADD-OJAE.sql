-- Add ojae@getdeploi.com (COO) to the staff list the database uses (2026-11-08, at the founder's request).
-- The database reads staff addresses from settings key 'staff_emails' (a JSON array) through staff_email_list();
-- Vercel's STAFF_EMAILS (Production and Preview) already lists hello@getdeploi.com, omarjames908@gmail.com and
-- ojae@getdeploi.com since 2026-11-08. This file makes the database list match. Run it in the Supabase SQL editor of
-- deploi-prod (makqaqzlylhckijdbjzi), and the same file in deploi-preview (bhddgjcefwasdyrrfptc) if you want them equal.
-- It changes one settings row (adds the addresses that are missing, keeps any others) and no profile.

-- 1. Read first: what the list holds now (NULL means there is no row yet)
select value from settings where key = 'staff_emails';

-- 2. Add the three addresses (idempotent: running it twice changes nothing)
begin;
insert into settings (key, value) values ('staff_emails', '["hello@getdeploi.com","omarjames908@gmail.com","ojae@getdeploi.com"]'::jsonb)
on conflict (key) do update set value = (
  select jsonb_agg(distinct x order by x) from (
    select lower(jsonb_array_elements_text(case when jsonb_typeof(settings.value) = 'array' then settings.value else '[]'::jsonb end)) as x
    union select unnest(array['hello@getdeploi.com','omarjames908@gmail.com','ojae@getdeploi.com'])
  ) s
);

-- 3. Check (one row, all true)
select position('ojae@getdeploi.com' in staff_email_list()) > 0 as ojae_listed,
       position('hello@getdeploi.com' in staff_email_list()) > 0 as hello_listed,
       position('omarjames908@gmail.com' in staff_email_list()) > 0 as omar_listed;
commit;
