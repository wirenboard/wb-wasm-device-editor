#### Сборка модуля WASM

1. Сборка Docker-образа [`emsdk`](https://hub.docker.com/r/emscripten/emsdk) c добавлением пакета `j2cli` (достаточно собрать один раз):
```
docker build --no-cache --tag emsdk:latest wasm
```

2. Сборка модуля WASM с помощь полученного Docker-образа:
```
docker run --rm -v $(pwd):/src -u $(id -u):$(id -g) emsdk:latest emmake make -f wasm.mk
```

Артефакты сборки будут помещены в папку `wasm`:
- `wasm/module.data` - "файловая система" модуля, включающая в себя файлы шаблонов устройств и JSON-схемы
- `wasm/module.js` - поключаемый JS-файл для загрузки модуля
- `wasm/module.wasm` - сам модуль

Дополнительные файлы для работы с модулем:
- `wasm/serial.js` - обертка для общения модуля с физическим портом посредством WebSerial API
- `wasm/script.js` - тестовый скрипт для демонстрации работоспособности модуля
- `wasm/index.html` - тестовый индексный файл для загрузки скриптов
