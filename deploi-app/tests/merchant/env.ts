/** Merchant product tests: own database when MERCHANT_TEST_DATABASE_URL is set; test-only secrets (never real). */
if (process.env.MERCHANT_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.MERCHANT_TEST_DATABASE_URL
process.env.SHOPIFY_API_KEY ||= 'test-api-key'
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret-0123456789'
process.env.CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
process.env.CREDENTIALS_KEY_ID ||= 'test-k1'
process.env.VERIFY_DELAY_MS ||= '5'
