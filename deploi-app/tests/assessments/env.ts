/** Assess-stream tests mutate seed rows; run them on their own database when ASSESS_TEST_DATABASE_URL is set. */
if (process.env.ASSESS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.ASSESS_TEST_DATABASE_URL
