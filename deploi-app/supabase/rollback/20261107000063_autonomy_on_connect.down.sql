-- Rollback of 20261107000063_autonomy_on_connect.sql (run after _guard.sql, inside one transaction).
-- Removes the on-connect bookkeeping and the pack_settings source columns. The record of which connections ran the
-- first check is refused while it holds rows unless deploi.rollback_discard_data = 'on'. The pacing ledger and the
-- backlog are operational state (held messages go out on the agents' normal schedule without them) and are dropped.
-- Agents, grants, packs and cases the first run created are kept: they belong to the customer.
select pg_temp.assert_empty('autonomy_connects');
drop table if exists autonomy_backlog;
drop table if exists autonomy_outbound;
drop table if exists autonomy_connects;
alter table pack_settings drop constraint if exists pack_settings_source_check;
alter table pack_settings drop column if exists inferred_from;
alter table pack_settings drop column if exists source;
