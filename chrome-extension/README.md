# DeepSeek → FreeDeepseekAPI (расширение)

Добавляет аккаунт DeepSeek в локальный FreeDeepseekAPI **одним кликом**: собирает
`token` + cookie (включая httpOnly) + `hif_*` с `chat.deepseek.com` и отправляет
на `http://localhost:9655/api/accounts/import`.

Работает в Firefox и Chrome/Edge (Manifest V3).

## Установка

**Firefox**
1. Откройте `about:debugging#/runtime/this-firefox`
2. «Загрузить временное дополнение» → выберите `manifest.json` из этой папки.
   (Временное дополнение: после перезапуска Firefox установить заново.)

**Chrome / Edge**
1. Откройте `chrome://extensions`
2. Включите «Режим разработчика».
3. «Загрузить распакованное» → выберите эту папку.

## Использование
1. Запустите FreeDeepseekAPI (порт 9655).
2. Откройте `chat.deepseek.com` и войдите в нужный аккаунт.
3. Клик по иконке расширения → **«➕ Добавить в FreeDeepseekAPI»**.

Для нескольких аккаунтов повторите из разных профилей/логинов браузера.

Вспомогательные кнопки: «Собрать» (показать креды), «Копировать JSON»,
«Скачать файл» (`deepseek-auth.json`) — на случай ручного импорта через дашборд.
