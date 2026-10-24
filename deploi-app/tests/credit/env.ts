/** Credit tests mutate seed rows; run them on their own database. ASSESS_TEST_DATABASE_URL (assess stream) or the older S6_DATABASE_URL both work. */
if (process.env.ASSESS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.ASSESS_TEST_DATABASE_URL
else if (process.env.S6_DATABASE_URL) process.env.DATABASE_URL = process.env.S6_DATABASE_URL
