-- Rollback of 20261104000041_customer_experience.sql. Rows it added to org_products stay (they are ordinary product rows).
drop trigger if exists org_products_default_commerce on agencies;
drop function if exists org_products_default_commerce();
