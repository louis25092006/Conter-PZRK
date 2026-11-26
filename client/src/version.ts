// Lab 8: штамп версії. Vite підставляє __APP_VERSION__ під час збірки (vite.config.ts → define);
// у тестах (Node без Vite) змінної немає — тоді 'dev'.
declare const __APP_VERSION__: string | undefined
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
