import { defineConfig, devices } from '@playwright/test'

// Lab 7, M2: e2e — два справжні браузери (контексти) в одній кімнаті.
// webServer сам запускає сервер гри + Vite (npm run dev) і чекає, доки відкриється :5173.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
