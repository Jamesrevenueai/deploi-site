-- Rollback of 20261104000038_woocommerce.sql (run after _guard.sql, inside one transaction).
-- WooCommerce connections themselves live in store_connections and are not removed here; without
-- woo_connections they fall back to their external_id and basic auth, and lose webhook verification.
select pg_temp.assert_empty('woo_connections');
select pg_temp.assert_empty('woo_auth_states');
drop table if exists woo_connections;
drop table if exists woo_auth_states;
