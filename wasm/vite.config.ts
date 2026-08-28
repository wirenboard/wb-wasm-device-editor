import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import commonjs from 'vite-plugin-commonjs';
import { viteSingleFile } from 'vite-plugin-singlefile';
import svgr from 'vite-plugin-svgr';
import { offlineEmbedPlugin } from './vite-plugin-offline-embed';

const homeuiNodeModules = path.resolve(__dirname, '../submodule/homeui/frontend/node_modules');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

function swCachePlugin(): Plugin {
  return {
    name: 'sw-cache-inject',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist-configurator');
      const swPath = path.join(outDir, 'sw.js');
      if (!fs.existsSync(swPath)) return;

      // Generate cache version from git commit hash
      let cacheVersion: string;
      try {
        cacheVersion = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
      } catch {
        cacheVersion = Date.now().toString(36);
      }

      // Discover hashed asset filenames. The DALI runtime is split out: it is
      // an order of magnitude larger than the rest and only the DALI view needs
      // it, so it is precached best-effort rather than as an install blocker.
      const assetsDir = path.join(outDir, 'assets');
      const isDaliRuntime = (name: string) =>
        /^(pyodide|python_stdlib|wbdali-|dali-worker)/.test(name);
      let hashedAssets: string[] = [];
      let daliAssets: string[] = [];
      if (fs.existsSync(assetsDir)) {
        for (const file of fs.readdirSync(assetsDir)) {
          (isDaliRuntime(file) ? daliAssets : hashedAssets).push(`/assets/${file}`);
        }
      }

      let sw = fs.readFileSync(swPath, 'utf-8');
      sw = sw.replace('\'__APP_VERSION__\'', `'${pkg.version}'`);
      sw = sw.replace('\'__CACHE_VERSION__\'', `'${cacheVersion}'`);
      sw = sw.replace(
        '// __HASHED_ASSETS__',
        hashedAssets.map((a) => `  '${a}'`).join(',\n'),
      );
      sw = sw.replace(
        '// __DALI_ASSETS__',
        daliAssets.map((a) => `  '${a}'`).join(',\n'),
      );
      fs.writeFileSync(swPath, sw);
      console.log(
        `[sw-cache-inject] Injected version=${pkg.version} cache=${cacheVersion}, `
          + `${hashedAssets.length} hashed assets, ${daliAssets.length} DALI runtime assets`,
      );
    },
  };
}

/**
 * `pyodide.asm.mjs` contains `new URL("pyodide.asm.wasm", import.meta.url).href`
 * inside `findWasmBinary()`. That branch is dead — the worker always passes
 * `indexURL`, so pyodide resolves the file through `Module.locateFile` — but
 * vite still recognises the pattern and emits a second copy of the 9.6 MB wasm.
 * In the offline build that copy is base64-inlined, adding ~13 MB to a file that
 * already carries the real one. Rewriting it to a plain string leaves vite
 * nothing to emit.
 */
function stripPyodideWasmUrl(): Plugin {
  return {
    name: 'strip-pyodide-wasm-url',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('pyodide.asm.mjs')) return null;
      const out = code.replace('new URL("pyodide.asm.wasm",import.meta.url).href', '"pyodide.asm.wasm"');
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * Rebuild the Pyodide bundle when the Python under `python/` changes.
 *
 * The worker loads Python from a tarball, not from the source tree, so without
 * this an edit to the daemon runtime is invisible until the next `npm run
 * build:python` — and the symptom is a stale-code error deep inside Pyodide
 * rather than anything pointing at the file that was edited.
 */
function rebuildPythonBundle(): Plugin {
  const pythonDir = path.resolve(__dirname, 'python');
  const watched = ['runtime', 'shims', 'vendor'].map((dir) => path.join(pythonDir, dir));

  return {
    name: 'rebuild-python-bundle',
    apply: 'serve',
    configureServer(server) {
      server.watcher.add(watched);
      server.watcher.on('all', (_event, file) => {
        if (!file.endsWith('.py') || !watched.some((dir) => file.startsWith(dir))) return;
        try {
          execSync('node scripts/build-python-bundle.mjs', { cwd: __dirname, stdio: 'inherit' });
          server.ws.send({ type: 'full-reload' });
        } catch (error) {
          server.config.logger.error(`[python-bundle] rebuild failed: ${error}`);
        }
      });
    },
  };
}

/**
 * Point homeui's MQTT client at the in-browser broker.
 *
 * homeui's DALI page reaches its transport through module singletons —
 * `daliProxy` and the stores import `mqttClient` rather than taking it
 * injected — so substituting that one module is the whole seam, and homeui's
 * own RPC proxy and stores run unchanged on top of it. It has to be done by
 * resolved path rather than by alias, because the imports of it are relative
 * from inside homeui's own tree.
 */
function redirectHomeuiMqttClient(): Plugin {
  const homeuiClient = path.resolve(
    __dirname, '../submodule/homeui/frontend/src/services/mqtt-client.ts');
  const ourClient = path.resolve(__dirname, 'src/dali-wasm/mqtt-client.ts');

  return {
    name: 'redirect-homeui-mqtt-client',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.includes('mqtt-client') || importer === ourClient) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === homeuiClient ? ourClient : null;
    },
  };
}

function throttleModuleData(): Plugin {
  const RATE = 500 * 1024; // 500 KB/s — ~12s for a 6 MB file
  const CHUNK_INTERVAL = 100; // send a chunk every 100ms
  const CHUNK_SIZE = Math.round(RATE * CHUNK_INTERVAL / 1000);

  return {
    name: 'throttle-module-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/module.data', (req, res, next) => {
        const filePath = path.resolve(__dirname, 'public', 'module.data');
        if (!fs.existsSync(filePath)) return next();

        const stat = fs.statSync(filePath);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
        let paused = false;

        req.on('close', () => stream.destroy());

        stream.on('data', (chunk) => {
          res.write(chunk);
          if (!paused) {
            paused = true;
            stream.pause();
            setTimeout(() => {
              paused = false; stream.resume();
            }, CHUNK_INTERVAL);
          }
        });
        stream.on('end', () => res.end());
        stream.on('error', () => next());
      });
    },
  };
}

export default defineConfig(() => {
  const offline = process.env.OFFLINE === '1';

  const injectScripts: Plugin = {
    name: 'inject-scripts',
    transformIndexHtml() {
      return [
        { tag: 'script', attrs: { src: '/serial.js', defer: true }, injectTo: 'head' },
        { tag: 'script', attrs: { src: '/script.js', defer: true }, injectTo: 'head' },
        { tag: 'script', attrs: { src: '/module.js', defer: true }, injectTo: 'head' },
      ];
    },
  };

  const plugins: PluginOption[] = [
    react(),
    commonjs(),
    svgr({ include: '**/*.svg' }),
    throttleModuleData(),
    stripPyodideWasmUrl(),
    rebuildPythonBundle(),
    redirectHomeuiMqttClient(),
  ];

  if (offline) {
    plugins.push(viteSingleFile({ removeViteModuleLoader: true }), offlineEmbedPlugin());
  } else {
    plugins.push(swCachePlugin(), injectScripts);
  }

  return {
    plugins,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_OFFLINE_BUILD__: JSON.stringify(offline),
    },
    build: {
      outDir: path.resolve(__dirname, offline ? 'dist-offline' : 'dist-configurator'),
      emptyOutDir: true,
    },

    server: {
      fs: {
        // homeui's own assets — its fonts, now that its styles live in src —
        // are a sibling of this app rather than inside it.
        allow: [__dirname, path.resolve(__dirname, '../submodule/homeui/frontend')],
      },
    },

    // The DALI worker is a module worker: it statically imports pyodide's glue,
    // which is code-split, and IIFE output cannot carry that.
    worker: {
      format: 'es',
    },

    optimizeDeps: {
      // Pyodide ships a large prebuilt ES module that must not be pre-bundled:
      // esbuild rewrites the `import.meta.url` its wasm loader depends on.
      exclude: ['pyodide'],
    },

    resolve: {
      alias: {
        // The offline page has every byte asset inlined, so it must not import
        // them by URL: singlefile would base64 each one a second time, inside
        // the already-base64 inline bundle.
        ...(offline
          ? {
            './pyodide-assets': path.resolve(__dirname, 'src/dali-wasm/pyodide-assets.offline.ts'),
            './worker-host': path.resolve(__dirname, 'src/dali-wasm/worker-host.offline.ts'),
          }
          : {}),

        '@': path.resolve(__dirname, '../submodule/homeui/frontend/src'),

        // homeui's dependencies, resolved from its own node_modules: this app
        // is a sibling of that tree, not inside it, so nothing walks up to
        // find them.
        react: path.resolve(homeuiNodeModules, 'react'),
        'react-dom': path.resolve(homeuiNodeModules, 'react-dom'),
        'react-dom/client': path.resolve(homeuiNodeModules, 'react-dom/client'),
        'react-i18next': path.resolve(homeuiNodeModules, 'react-i18next'),
        i18next: path.resolve(homeuiNodeModules, 'i18next'),
        classnames: path.resolve(homeuiNodeModules, 'classnames'),
        mobx: path.resolve(homeuiNodeModules, 'mobx'),
        'mobx-react-lite': path.resolve(homeuiNodeModules, 'mobx-react-lite'),
        'react-router-dom': path.resolve(homeuiNodeModules, 'react-router-dom'),
        'react-responsive': path.resolve(homeuiNodeModules, 'react-responsive'),
        bootstrap: path.resolve(homeuiNodeModules, 'bootstrap'),
        'glyphicons-only-bootstrap': path.resolve(homeuiNodeModules, 'glyphicons-only-bootstrap'),
      },
    },
    dedupe: ['react', 'react-dom'],
  };
});
