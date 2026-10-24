// tests/setup.ts forces .env.test; the web stream runs against its own database when asked.
if (process.env.WEB_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.WEB_TEST_DATABASE_URL
export {}
