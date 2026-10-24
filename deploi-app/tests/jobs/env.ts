if (process.env.JOBS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.JOBS_TEST_DATABASE_URL
/** Ops stream: tests/workers, tests/consent, tests/evv, tests/imports and tests/jobs run on deploi_test_d when OPS_TEST_DATABASE_URL is set. */
if (process.env.OPS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.OPS_TEST_DATABASE_URL
