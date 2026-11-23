import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // Lab 7: вимога курсу — покриття shared/ не нижче 85 %
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
})
