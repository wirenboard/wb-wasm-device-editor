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

      // Discover hashed asset filenames
      const assetsDir = path.join(outDir, 'assets');
      let hashedAssets: string[] = [];
      if (fs.existsSync(assetsDir)) {
        hashedAssets = fs.readdirSync(assetsDir).map((f) => `/assets/${f}`);
      }

      let sw = fs.readFileSync(swPath, 'utf-8');
      sw = sw.replace('\'__APP_VERSION__\'', `'${pkg.version}'`);
      sw = sw.replace('\'__CACHE_VERSION__\'', `'${cacheVersion}'`);
      sw = sw.replace(
        '// __HASHED_ASSETS__',
        hashedAssets.map((a) => `  '${a}'`).join(',\n'),
      );
      fs.writeFileSync(swPath, sw);
      console.log(`[sw-cache-inject] Injected version=${pkg.version} cache=${cacheVersion}, ${hashedAssets.length} hashed assets`);
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

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '../submodule/homeui/frontend/src'),

        'glyphicons-only-bootstrap': path.resolve(homeuiNodeModules, 'glyphicons-only-bootstrap'),
        'bootstrap': path.resolve(homeuiNodeModules, 'bootstrap'),

        react: path.resolve(homeuiNodeModules, 'react'),
        'react-dom': path.resolve(homeuiNodeModules, 'react-dom'),
        'react-dom/client': path.resolve(homeuiNodeModules, 'react-dom/client'),
        'react-i18next': path.resolve(homeuiNodeModules, 'react-i18next'),
        i18next: path.resolve(homeuiNodeModules, 'i18next'),
        classnames: path.resolve(homeuiNodeModules, 'classnames'),
        mobx: path.resolve(homeuiNodeModules, 'mobx'),
        'mobx-react-lite': path.resolve(homeuiNodeModules, 'mobx-react-lite'),
      },
    },
    dedupe: ['react', 'react-dom'],
  };
});
