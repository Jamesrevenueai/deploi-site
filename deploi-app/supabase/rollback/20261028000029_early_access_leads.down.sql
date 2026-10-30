-- Rollback of 20261028000029_early_access_leads.sql (run after _guard.sql, inside one transaction).
drop function if exists public_create_early_access(text, text, text, text, text[], text, text);

-- The five prospects columns belong to consulting migration 20261021000027. This migration only added them when 027 never
-- ran, so only then are they dropped; if 027 is recorded they stay. Early access data in them needs the discard flag.
do $$
begin
  if to_regclass('_migrations') is not null and exists (select 1 from _migrations where name = '20261021000027_website.sql') then
    return;
  end if;
  if exists (select 1 from prospects where service_interest <> 'operations' or tags <> '{}' or website_url is not null or website_goal is not null or website_details <> '{}'::jsonb)
     and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: prospects hold early access data in the columns this migration added; set deploi.rollback_discard_data = ''on'' to discard them';
  end if;
  drop index if exists prospects_tags_idx;
  drop index if exists prospects_service_interest_idx;
  alter table prospects drop column if exists service_interest, drop column if exists tags, drop column if exists website_url,
    drop column if exists website_goal, drop column if exists website_details;
end $$;
