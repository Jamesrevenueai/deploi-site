import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'lib/**/*.test.ts', 'workers/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
})
