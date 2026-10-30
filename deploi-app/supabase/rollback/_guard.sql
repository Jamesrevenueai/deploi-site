-- Shared by every rollback: refuse to drop a table that holds rows unless the operator explicitly
-- allows data loss for this session with:  set deploi.rollback_discard_data = 'on';
create or replace function pg_temp.assert_empty(t text) returns void language plpgsql as $$
declare n bigint;
begin
  if to_regclass(t) is null then return; end if;
  execute format('select count(*) from %s', t) into n;
  if n > 0 and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: % has % row(s); set deploi.rollback_discard_data = ''on'' to discard them', t, n;
  end if;
end $$;
