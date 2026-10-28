-- Rollback of 20261028000031_email.sql
select pg_temp.assert_empty('email_messages');
select pg_temp.assert_empty('email_accounts');
drop table if exists synthetic_email_state;
drop table if exists email_messages;
drop table if exists email_oauth_states;
drop table if exists email_credentials;
drop table if exists email_accounts;
