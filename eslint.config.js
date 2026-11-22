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
  // спільний пакет — лише те, що є І в браузері, І в Node (EventTarget, URL, TextEncoder…)
  {
    files: ['shared/src/**/*.js'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  // сервер, тести і скрипти — Node
  {
    files: [
      'server/**/*.js',
      'shared/test/**/*.js',
      'scripts/**/*.mjs',
      'client/scripts/**/*.mjs',
      'client/tests/**/*.js',
    ],
    languageOptions: { globals: globals.node },
  },
  prettier,
]
