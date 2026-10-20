/** Item 6 tests mutate seed rows; run them on their own database when S6_DATABASE_URL is set. */
if (process.env.S6_DATABASE_URL) process.env.DATABASE_URL = process.env.S6_DATABASE_URL
