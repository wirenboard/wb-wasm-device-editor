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

Один HTML-файл, открываемый по `file://` без HTTP-сервера — для распространения на компьютеры без сети. Внутрь зашиты приложение, WASM-модуль, шаблоны устройств, а также все стабильные и testing прошивки и загрузчики с `fw-releases.wirenboard.com`. Прошивки скачивает на этапе сборки Vite-плагин `vite-plugin-offline-embed.ts` (функция `buildFirmwareBundle`) и кеширует в `wasm/.firmware-cache/` (gitignored), чтобы повторные сборки не дёргали S3.

Сборка после шагов 1–5 выше:
```
docker run --rm -v $(PWD):/src -w /src/wasm node:latest npm run build:offline
```

Результат: `wasm/dist-offline/index.html` (~25 МБ). Открывается двойным кликом в Chrome/Edge 80+ — WebSerial API работает на `file://` только в Chromium-браузерах. Внутри одного файла: приложение, WASM-модуль конфигуратора, шаблоны устройств, каталог прошивок (~8 МБ) и среда выполнения DALI-конфигуратора — интерпретатор Python (Pyodide) с бандлом wb-mqtt-dali.

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

Тесты проверяют работу Service Worker (офлайн-режим, обнаружение обновлений, медленное соединение) и DALI-конфигуратор целиком: страница загружается против симулируемого шлюза (slave id 250) — Pyodide, демон wb-mqtt-dali и интерфейс без железа и без сети.

#### Тесты DALI-рантайма (Python)

Python-код, работающий внутри Pyodide, тестируется под обычным CPython против симулятора модуля WB-DALI:

```
cd wasm/python
pip install -r requirements-dev.txt
python3 -m pytest
```

#### Юнит-тесты TypeScript

```
cd wasm
npm test
```
