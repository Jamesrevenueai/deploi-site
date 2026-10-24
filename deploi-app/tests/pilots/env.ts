/** Engage-stream tests mutate seed rows; run them on their own database:
 *   ENGAGE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/deploi_test_c npx vitest run tests/pilots */
if (process.env.ENGAGE_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.ENGAGE_TEST_DATABASE_URL
