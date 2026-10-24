# Автотест (разработка)

Проверяет сайт в настоящем браузере: вход, приход по PDF, списание, инвентаризацию, скан УПД, роли.
Вместо Claude API используется заглушка `mockai.js`, поэтому ответы распознавания зашиты в неё.

1. `npm i -D playwright` (один раз, в этой папке или глобально) и `npx playwright install chromium`.
2. Положите рядом два PDF: файл счёта, имя которого начинается на `7a5fab74`, и скан УПД, имя которого начинается на `c23d81c8`, и укажите папку: `DOCS_DIR=/путь`.
3. Запустите заглушку и сервер на чистой базе:
   ```
   node dev/mockai.js &
   PORT=3100 DATA_DIR=/tmp/skdata ADMIN_LOGIN=admin ADMIN_PASSWORD=testtest123 ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://localhost:4010 node server.js &
   DOCS_DIR=/путь node dev/e2e.js
   ```
Проверка режима Яндекса (та же заглушка отвечает за OCR и YandexGPT):
   ```
   PORT=3100 DATA_DIR=/tmp/skdata ADMIN_LOGIN=admin ADMIN_PASSWORD=testtest123 AI_PROVIDER=yandex YANDEX_API_KEY=x YANDEX_FOLDER_ID=b1gtest YANDEX_BASE_URL=http://localhost:4010 node server.js &
   PROVIDER=yandex DOCS_DIR=/путь node dev/e2e.js
   ```
Тест не идемпотентен: перед каждым запуском удаляйте `DATA_DIR`. Не используйте `pkill -f "node server.js"`: команда убьёт и собственную оболочку.
