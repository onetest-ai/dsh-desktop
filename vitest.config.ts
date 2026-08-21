import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    exclude: ['tests/smoke.spec.ts'],
    testTimeout: 30_000,
  },
})
