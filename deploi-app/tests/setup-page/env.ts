/** Item 8 tests run on their own database when S8_DATABASE_URL is set (tests/setup.ts forces .env.test). */
if (process.env.S8_DATABASE_URL) process.env.DATABASE_URL = process.env.S8_DATABASE_URL
