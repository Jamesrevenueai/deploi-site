/** Ops stream test database (deploi_test_d). Import this first in every test file of the suite. */
if (process.env.OPS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.OPS_TEST_DATABASE_URL
