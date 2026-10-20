/** tests/setup.ts forces .env.test; the BAA suite runs on its own database when BAA_DATABASE_URL is set. */
if (process.env.BAA_DATABASE_URL) process.env.DATABASE_URL = process.env.BAA_DATABASE_URL
