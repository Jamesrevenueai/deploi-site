import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const compat = new FlatCompat({ baseDirectory: __dirname })

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'proof/**', '.storage/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    // HIPAA boundary: anything under lib/phi may only talk to the local Ollama lane.
    files: ['lib/phi/**/*.ts', 'lib/phi/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '(^|/)llm(/index|/cloud)?$|^openai|^@anthropic-ai|^resend|^twilio', message: 'lib/phi may only import lib/llm/local (Ollama).' },
        ],
      }],
    },
  },
]

export default eslintConfig
