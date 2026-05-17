#### Сборка конфигуратора

1. Сборка Docker-образа [`emsdk`](https://hub.docker.com/r/emscripten/emsdk) c добавлением пакета `j2cli` (достаточно собрать один раз):
```
docker build --no-cache --tag emsdk:latest emsdk
```

2. Сборка модуля _WASM_ с помощь полученного Docker-образа:
```
docker run --rm -v $(pwd):/src -u $(id -u):$(id -g) emsdk:latest emmake make -f wasm.mk
```

3. Установка модулей _Node.js_ для сабмодуля homeui:
```
docker run --rm -v $(PWD):/src -w /src/submodule/homeui/frontend node:latest npm install
```

4. Установка модулей _Node.js_ для сборки конфигуратора:
```
docker run --rm -v $(PWD):/src -w /src/wasm node:latest npm install
```

5. Сборка конфигуратора:
```
docker run --rm -v $(PWD):/src -w /src/wasm node:latest npm run build
```

6. Сборка Docker-образа с конфигуратором:
```
docker build --no-cache --tag wb-wasm-device-editor:latest wasm
```

После сборки готовые файлы конфигуратора будут находиться в директории `wasm/dist-configurator`.

#### Автономная (standalone) сборка

Один HTML-файл, открываемый по `file://` без HTTP-сервера — для распространения на компьютеры без сети. Внутрь зашиты приложение, WASM-модуль, шаблоны устройств, а также все стабильные и testing прошивки и загрузчики с `fw-releases.wirenboard.com` (загружаются при сборке, кешируются в `wasm/.firmware-cache/`).

Сборка после шагов 1–5 выше:
```
docker run --rm -v $(PWD):/src -w /src/wasm node:latest npm run build:offline
```

Результат: `wasm/dist-offline/index.html` (~14 МБ). Открывается двойным кликом в Chrome/Edge 80+, Firefox 113+, Safari 16.4+ (нужен `DecompressionStream`). WebSerial работает на `file://` в Chromium.

При наличии сети обновление прошивок идёт с `fw-releases.wirenboard.com`, иначе используется встроенная копия. Так же приложение проверяет `https://deveditor.wirenboard.com/sw.js` и показывает баннер, если онлайн-версия новее.

CI публикует автономную версию по адресу `https://deveditor.wirenboard.com/offline/index.html` с заголовком `Content-Disposition`, чтобы браузер сохранял файл как `wb-device-editor-<версия>.html`. Этот же файл включён в `dist-configurator.tar.gz` и в Docker-образ.

#### E2E-тесты

Для запуска E2E-тестов необходимо сначала собрать конфигуратор (шаги 1-5), затем:

1. Установка Playwright и браузера Chromium:
```
npx playwright install --with-deps chromium
```

2. Запуск тестов:
```
cd wasm
npm run test:e2e
```

Тесты проверяют работу Service Worker: офлайн-режим, обнаружение обновлений и поведение при медленном соединении.
