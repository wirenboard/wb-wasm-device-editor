# Changelog

## [1.11.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.10.0...wb-wasm-device-editor-v1.11.0) (2026-07-21)


### Features

* add USB device 04E2:1411 to serial port filter ([#90](https://github.com/wirenboard/wb-wasm-device-editor/issues/90)) ([7f5ae5d](https://github.com/wirenboard/wb-wasm-device-editor/commit/7f5ae5d3f6c516b56dc11dcfaaf7f3a9acddcd9a))

## [1.10.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.9.2...wb-wasm-device-editor-v1.10.0) (2026-05-25)


### Features

* offline single-file build with embedded firmware ([#86](https://github.com/wirenboard/wb-wasm-device-editor/issues/86)) ([6e3bd04](https://github.com/wirenboard/wb-wasm-device-editor/commit/6e3bd04ad03b9fdc2f6a0ff53812a1db76e22fcc))

## [1.9.2](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.9.1...wb-wasm-device-editor-v1.9.2) (2026-05-25)


### Bug Fixes

* stop port picker dialog from reopening on cancel ([#87](https://github.com/wirenboard/wb-wasm-device-editor/issues/87)) ([6ceb124](https://github.com/wirenboard/wb-wasm-device-editor/commit/6ceb1244f157a4ac8518135f7619739fe161e4f6))

## [1.9.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.9.0...wb-wasm-device-editor-v1.9.1) (2026-05-12)


### Bug Fixes

* **ci:** pin Playwright to 1.59.1 to match CI image ([#84](https://github.com/wirenboard/wb-wasm-device-editor/issues/84)) ([2fde114](https://github.com/wirenboard/wb-wasm-device-editor/commit/2fde1142eebeb29efa2029c3f5fb679f2b477c8a))

## [1.9.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.8.4...wb-wasm-device-editor-v1.9.0) (2026-05-12)


### Features

* stable/testing release channel switcher ([#82](https://github.com/wirenboard/wb-wasm-device-editor/issues/82)) ([1caeca0](https://github.com/wirenboard/wb-wasm-device-editor/commit/1caeca002b56625e06fd823a0c7ea39f681dc136))

## [1.8.4](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.8.3...wb-wasm-device-editor-v1.8.4) (2026-05-07)


### Bug Fixes

* **serial:** surface init failure to UI ([#80](https://github.com/wirenboard/wb-wasm-device-editor/issues/80)) ([4d14d8a](https://github.com/wirenboard/wb-wasm-device-editor/commit/4d14d8a837c9da5e252e50d4834367c99a29137a))

## [1.8.3](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.8.2...wb-wasm-device-editor-v1.8.3) (2026-05-06)


### Bug Fixes

* **sw:** reject HTML responses for /assets/* to defend against CDN cache poisoning ([#76](https://github.com/wirenboard/wb-wasm-device-editor/issues/76)) ([e88350c](https://github.com/wirenboard/wb-wasm-device-editor/commit/e88350ce2ce8ee50fe2fcff6d2f1a0700326854b))

## [1.8.2](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.8.1...wb-wasm-device-editor-v1.8.2) (2026-04-23)


### Bug Fixes

* revert WebUSB features ([#73](https://github.com/wirenboard/wb-wasm-device-editor/issues/73)) ([62c22bd](https://github.com/wirenboard/wb-wasm-device-editor/commit/62c22bdf647eb6227bad27434d5edfad9053358f))

## [1.8.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.8.0...wb-wasm-device-editor-v1.8.1) (2026-04-22)


### Bug Fixes

* try USB device reset before claiming interface on Android ([#71](https://github.com/wirenboard/wb-wasm-device-editor/issues/71)) ([577c2f9](https://github.com/wirenboard/wb-wasm-device-editor/commit/577c2f9309d3e90a6186cdd8c53434a391e4f660))

## [1.8.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.7.4...wb-wasm-device-editor-v1.8.0) (2026-04-21)


### Features

* add WebUSB polyfill fallback for Android and non-WebSerial browsers ([#69](https://github.com/wirenboard/wb-wasm-device-editor/issues/69)) ([7c95e8f](https://github.com/wirenboard/wb-wasm-device-editor/commit/7c95e8f668d4d5c34ff9428e42d96001107f22f2))

## [1.7.4](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.7.3...wb-wasm-device-editor-v1.7.4) (2026-04-20)


### Bug Fixes

* filter readonly params on save, fix escaped quotes in errors ([#67](https://github.com/wirenboard/wb-wasm-device-editor/issues/67)) ([5b2faa6](https://github.com/wirenboard/wb-wasm-device-editor/commit/5b2faa6bd2789c532aae433d3cfe1fda5e58c8bb))

## [1.7.3](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.7.2...wb-wasm-device-editor-v1.7.3) (2026-04-17)


### Bug Fixes

* skip settings read for devices in bootloader mode ([#65](https://github.com/wirenboard/wb-wasm-device-editor/issues/65)) ([25dd77c](https://github.com/wirenboard/wb-wasm-device-editor/commit/25dd77c81cfba66a82f477482c2664e22b7206a1))

## [1.7.2](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.7.1...wb-wasm-device-editor-v1.7.2) (2026-04-13)


### Bug Fixes

* deduplicate channels in runtime view ([#63](https://github.com/wirenboard/wb-wasm-device-editor/issues/63)) ([2c7071d](https://github.com/wirenboard/wb-wasm-device-editor/commit/2c7071d4d3570e29af08679279c639ce8c7dcbd4))

## [1.7.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.7.0...wb-wasm-device-editor-v1.7.1) (2026-04-10)


### Bug Fixes

* UI improvements and bug fixes ([#60](https://github.com/wirenboard/wb-wasm-device-editor/issues/60)) ([d14c95c](https://github.com/wirenboard/wb-wasm-device-editor/commit/d14c95cb4d6120de2a25f3caf5d773c3781e1332))

## [1.7.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.6.1...wb-wasm-device-editor-v1.7.0) (2026-04-09)


### Features

* add changelog ([#36](https://github.com/wirenboard/wb-wasm-device-editor/issues/36)) ([581c497](https://github.com/wirenboard/wb-wasm-device-editor/commit/581c4978e73139bd78ff5c6a508357d552ff7945))
* add extended timeout for firmware restore ([#49](https://github.com/wirenboard/wb-wasm-device-editor/issues/49)) ([2a2b471](https://github.com/wirenboard/wb-wasm-device-editor/commit/2a2b471af809628d95724a84b15ae28b5814128b))
* add firmware update support ([#42](https://github.com/wirenboard/wb-wasm-device-editor/issues/42)) ([80d5ab9](https://github.com/wirenboard/wb-wasm-device-editor/commit/80d5ab9151a0c16cbbdb8c1123c08d9690fdd8b1))
* add more USB-TTL chip VID/PID filters ([#57](https://github.com/wirenboard/wb-wasm-device-editor/issues/57)) ([c9b2ffe](https://github.com/wirenboard/wb-wasm-device-editor/commit/c9b2ffee2cd8afcf5d0aba27464dd073d4d86ac8))
* bootloader device scanning and firmware restore ([#44](https://github.com/wirenboard/wb-wasm-device-editor/issues/44)) ([55ec317](https://github.com/wirenboard/wb-wasm-device-editor/commit/55ec3170587c5920a44455cc85f713d64a6da7c2))
* optimize bootloader scan and firmware restore ([#48](https://github.com/wirenboard/wb-wasm-device-editor/issues/48)) ([cc6b72c](https://github.com/wirenboard/wb-wasm-device-editor/commit/cc6b72c95ff714079ff9116ded9d8b65b5aff206))
* show unsupported channels in runtime view instead of hiding them ([#52](https://github.com/wirenboard/wb-wasm-device-editor/issues/52)) ([d77b27b](https://github.com/wirenboard/wb-wasm-device-editor/commit/d77b27b421ca32ea3622caeed0b813f35fcfda24))


### Bug Fixes

* add description to package.json to bootstrap release-please ([#33](https://github.com/wirenboard/wb-wasm-device-editor/issues/33)) ([3b8ca90](https://github.com/wirenboard/wb-wasm-device-editor/commit/3b8ca906c1cc1892eab7f46a3c37d05d8f5f8875))
* enums in runtime view ([#55](https://github.com/wirenboard/wb-wasm-device-editor/issues/55)) ([c43b811](https://github.com/wirenboard/wb-wasm-device-editor/commit/c43b8119551bc1a13f98d2dec4cc269c29655d60))
* exclude device_type from parameters in deviceSet RPC request ([#45](https://github.com/wirenboard/wb-wasm-device-editor/issues/45)) ([84b8527](https://github.com/wirenboard/wb-wasm-device-editor/commit/84b8527e1aa9d9c17c39de45ba7c5df86f28fb14))

## [1.6.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.6.0...wb-wasm-device-editor-v1.6.1) (2026-04-08)


### Bug Fixes

* enums in runtime view ([#55](https://github.com/wirenboard/wb-wasm-device-editor/issues/55)) ([c43b811](https://github.com/wirenboard/wb-wasm-device-editor/commit/c43b8119551bc1a13f98d2dec4cc269c29655d60))

## [1.6.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.5.0...wb-wasm-device-editor-v1.6.0) (2026-04-08)


### Features

* show unsupported channels in runtime view instead of hiding them ([#52](https://github.com/wirenboard/wb-wasm-device-editor/issues/52)) ([d77b27b](https://github.com/wirenboard/wb-wasm-device-editor/commit/d77b27b421ca32ea3622caeed0b813f35fcfda24))

## [1.5.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.4.0...wb-wasm-device-editor-v1.5.0) (2026-04-08)


### Features

* optimize bootloader scan and firmware restore ([#48](https://github.com/wirenboard/wb-wasm-device-editor/issues/48)) ([cc6b72c](https://github.com/wirenboard/wb-wasm-device-editor/commit/cc6b72c95ff714079ff9116ded9d8b65b5aff206))

## [1.4.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.3.0...wb-wasm-device-editor-v1.4.0) (2026-04-08)


### Features

* add extended timeout for firmware restore ([#49](https://github.com/wirenboard/wb-wasm-device-editor/issues/49)) ([2a2b471](https://github.com/wirenboard/wb-wasm-device-editor/commit/2a2b471af809628d95724a84b15ae28b5814128b))

## [1.3.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.2.1...wb-wasm-device-editor-v1.3.0) (2026-04-07)


### Features

* bootloader device scanning and firmware restore ([#44](https://github.com/wirenboard/wb-wasm-device-editor/issues/44)) ([55ec317](https://github.com/wirenboard/wb-wasm-device-editor/commit/55ec3170587c5920a44455cc85f713d64a6da7c2))

## [1.2.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.2.0...wb-wasm-device-editor-v1.2.1) (2026-04-04)


### Bug Fixes

* exclude device_type from parameters in deviceSet RPC request ([#45](https://github.com/wirenboard/wb-wasm-device-editor/issues/45)) ([84b8527](https://github.com/wirenboard/wb-wasm-device-editor/commit/84b8527e1aa9d9c17c39de45ba7c5df86f28fb14))

## [1.2.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.1.0...wb-wasm-device-editor-v1.2.0) (2026-04-03)


### Features

* add firmware update support ([#42](https://github.com/wirenboard/wb-wasm-device-editor/issues/42)) ([80d5ab9](https://github.com/wirenboard/wb-wasm-device-editor/commit/80d5ab9151a0c16cbbdb8c1123c08d9690fdd8b1))

## [1.1.0](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.0.1...wb-wasm-device-editor-v1.1.0) (2026-03-20)


### Features

* Add service worker
* Show offline indicator when server is unreachable

## [1.0.1](https://github.com/wirenboard/wb-wasm-device-editor/compare/wb-wasm-device-editor-v1.0.0...wb-wasm-device-editor-v1.0.1) (2026-03-20)


### Features

* Manual device add support
