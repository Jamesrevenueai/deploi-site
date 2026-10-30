-- Early access applications from the website (subscription product). Public intake stays behind a
-- SECURITY DEFINER function so the anon role never touches tables. A store URL and the platforms
-- chosen are recorded; applications are tagged "Early Access" plus one tag per platform.
-- The prospects columns below were first added by the consulting website migration (20261021000027). They are repeated
-- here, idempotently, so this migration does not depend on it: production is behind 20261021000022 and 027 has not
-- run there, so without them public_create_early_access() would fail at runtime ("column website_url does not exist").
alter table prospects add column if not exists service_interest text not null default 'operations';
alter table prospects add column if not exists tags text[] not null default '{}';
alter table prospects add column if not exists website_url text;
alter table prospects add column if not exists website_goal text;
alter table prospects add column if not exists website_details jsonb not null default '{}'::jsonb;
create index if not exists prospects_tags_idx on prospects using gin (tags);
create index if not exists prospects_service_interest_idx on prospects (service_interest);

create or replace function public_create_early_access(
  p_name text, p_email text, p_company text, p_store_url text, p_platforms text[], p_catalog_size text, p_message text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_company text; v_platforms text[]; v_size text; v_tags text[];
begin
  if p_store_url is null or p_store_url !~* '^https?://[^\s/]+\.[^\s]+' then raise exception 'invalid store url'; end if;
  select coalesce(array_agg(distinct p order by p), '{}') into v_platforms from unnest(coalesce(p_platforms, '{}')) p where p in ('shopify','woocommerce','amazon');
  if array_length(v_platforms, 1) is null then raise exception 'at least one platform is required'; end if;
  v_size := case when p_catalog_size in ('under_100','100_1000','1000_10000','over_10000') then p_catalog_size else null end;
  v_company := coalesce(nullif(trim(p_company), ''), 'Unknown store');
  v_tags := array['Early Access'] || array(select case p when 'shopify' then 'Shopify' when 'woocommerce' then 'WooCommerce' else 'Amazon' end from unnest(v_platforms) p);
  select id into v_id from prospects where lower(email) = lower(p_email) and lower(agency_name) = lower(v_company) limit 1;
  if v_id is null then
    insert into prospects (agency_name, owner_name, email, state, source, stage, service_interest, tags, website_url, website_details)
    values (v_company, p_name, p_email, '', 'site', 'new', 'early_access', v_tags, left(p_store_url, 500),
            jsonb_strip_nulls(jsonb_build_object('platforms', to_jsonb(v_platforms), 'catalog_size', v_size)))
    returning id into v_id;
  else
    update prospects set service_interest = 'early_access', tags = (select array(select distinct t from unnest(tags || v_tags) t)),
      website_url = coalesce(website_url, left(p_store_url, 500)),
      website_details = website_details || jsonb_strip_nulls(jsonb_build_object('platforms', to_jsonb(v_platforms), 'catalog_size', v_size))
    where id = v_id;
  end if;
  insert into touches (prospect_id, channel, direction, subject, body, meta)
  values (v_id, 'site', 'inbound', 'Early access application', left(p_message, 4000), jsonb_build_object('source', 'site', 'platforms', to_jsonb(v_platforms)));
  return v_id;
end $$;
revoke all on function public_create_early_access(text,text,text,text,text[],text,text) from public;
grant execute on function public_create_early_access(text,text,text,text,text[],text,text) to anon, authenticated, service_role;
