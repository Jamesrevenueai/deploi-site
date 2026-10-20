/** tests/setup.ts forces .env.test; the invite suite runs on its own DB when USERS_TEST_DATABASE_URL is set. */
if (process.env.USERS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.USERS_TEST_DATABASE_URL
