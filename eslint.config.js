import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'site/**',
      'coverage/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
      'server/logs/**',
      // синтаксис %OptimizeFunctionOnNextCall — лише для node --allow-natives-syntax, парсер його не знає
      'server/scripts/experiments/deopt.js',
    ],
  },
  js.configs.recommended,
  // Lab 7: правила З ПЕРЕВІРКОЮ ТИПІВ — лінтер бачить типи з tsconfig кожного пакета
  // (no-floating-promises, no-unsafe-*, no-misused-promises…)
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        projectService: { allowDefaultProject: ['playwright.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // any заборонено взагалі; as — теж немає (див. README, Lab 6)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // readonly kind: 'ship' = 'ship' — анотація замість `as const`: ми рахуємо кожен as
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // проміс, який ніхто не чекає і не ловить, — тихо загублена помилка (на сервері — падіння процесу)
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  // звичайний JS (конфіги, scripts/dev.mjs) — без перевірки типів
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  // клієнт — браузер
  {
    files: ['client/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  // Lab 8: service worker PWA
  {
    files: ['client/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  // спільний пакет — лише те, що є І в браузері, І в Node (URL, TextEncoder…)
  {
    files: ['shared/src/**/*.ts'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  // сервер, тести, скрипти, конфіги — Node
  {
    files: [
      'server/**/*.ts',
      'server/scripts/experiments/*.js',
      'shared/test/**/*.ts',
      '**/vitest.config.ts',
      'scripts/**/*.mjs',
      'client/scripts/**/*.ts',
      'client/tests/**/*.ts',
      'client/vite.config.ts',
      'e2e/**/*.ts',
      'playwright.config.ts',
      'eslint.config.js',
    ],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
