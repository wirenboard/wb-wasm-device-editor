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
