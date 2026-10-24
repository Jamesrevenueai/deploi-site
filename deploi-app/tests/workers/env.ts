/**
 * tests/setup.ts forces DATABASE_URL to .env.test's shared deploi_test. Section 7's
 * runtime tests mutate seed rows, so they run on their own database when S7_DATABASE_URL is set:
 *   S7_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/deploi_test_s7 npx vitest run tests/workers
 */
if (process.env.S7_DATABASE_URL) process.env.DATABASE_URL = process.env.S7_DATABASE_URL
/** Ops stream: tests/workers, tests/consent, tests/evv, tests/imports and tests/jobs run on deploi_test_d when OPS_TEST_DATABASE_URL is set. */
if (process.env.OPS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.OPS_TEST_DATABASE_URL
