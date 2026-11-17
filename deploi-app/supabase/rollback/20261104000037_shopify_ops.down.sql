-- Rollback of 20261104000037_shopify_ops.sql. Refuses to discard rows unless deploi.rollback_discard_data = 'on'
-- (see _guard.sql, which must run first in the same session).
select pg_temp.assert_empty('supplier_requests');
select pg_temp.assert_empty('shopify_compliance_requests');
drop table if exists supplier_requests;
drop table if exists shopify_compliance_requests;
drop table if exists shopify_rescan_queue;
-- supplier mappings exist only with this migration
delete from reference_sources where kind = 'supplier_mapping';
alter table reference_sources drop constraint if exists reference_sources_kind_check;
alter table reference_sources add constraint reference_sources_kind_check check (kind in ('price_list', 'sku_mapping', 'publication_list'));
alter table store_connections drop column if exists reauth_required_at;
alter table store_connections drop column if exists status_reason;
