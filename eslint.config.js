import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
  },
  // клієнт — браузер
  {
    files: ['client/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  // сервер і скрипти — Node
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'client/scripts/**/*.mjs', 'client/tests/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  prettier,
]
