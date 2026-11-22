import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'site/**'] },
  js.configs.recommended,
  // Lab 6: правила для TypeScript (без type-aware режиму — типи й так перевіряє tsc)
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      // any заборонено взагалі; as — лише там, де без нього ніяк (див. README, Lab 6)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // readonly kind: 'ship' = 'ship' — анотація замість `as const`: ми рахуємо кожен as
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // клієнт — браузер
  {
    files: ['client/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  // спільний пакет — лише те, що є І в браузері, І в Node (URL, TextEncoder…)
  {
    files: ['shared/src/**/*.ts'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  // сервер, тести і скрипти — Node
  {
    files: [
      'server/**/*.ts',
      'shared/test/**/*.ts',
      'scripts/**/*.mjs',
      'client/scripts/**/*.ts',
      'client/tests/**/*.ts',
      'client/vite.config.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
