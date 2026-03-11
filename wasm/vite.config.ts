import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import commonjs from 'vite-plugin-commonjs';
import svgr from 'vite-plugin-svgr';

const homeuiNodeModules = path.resolve(__dirname, '../submodule/homeui/frontend/node_modules');

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
      sw = sw.replace('\'__CACHE_VERSION__\'', `'${cacheVersion}'`);
      sw = sw.replace(
        '// __HASHED_ASSETS__',
        hashedAssets.map((a) => `  '${a}'`).join(',\n'),
      );
      fs.writeFileSync(swPath, sw);
      console.log(`[sw-cache-inject] Injected version=${cacheVersion}, ${hashedAssets.length} hashed assets`);
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
            setTimeout(() => { paused = false; stream.resume(); }, CHUNK_INTERVAL);
          }
        });
        stream.on('end', () => res.end());
        stream.on('error', () => next());
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      commonjs(),
      svgr({ include: '**/*.svg' }),
      swCachePlugin(),
      throttleModuleData(),
      {
        name: 'inject-scripts',
        transformIndexHtml() {
          return [
            {
              tag: 'script',
              attrs: { src: '/serial.js', async: true },
              injectTo: 'head',
            },
            {
              tag: 'script',
              attrs: { src: '/script.js', async: true },
              injectTo: 'head',
            },
            {
              tag: 'script',
              attrs: { src: '/module.js', async: true },
              injectTo: 'head',
            },
          ];
        },
      },
    ],
    build: {
      outDir: path.resolve(__dirname, 'dist-configurator'),
      emptyOutDir: true,
    },

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '../submodule/homeui/frontend/src'),
        '~': path.resolve(__dirname, '../submodule/homeui/frontend/app/scripts'),
        '~scripts': path.resolve(__dirname, '../submodule/homeui/frontend/app/scripts'),
        '~styles': path.resolve(__dirname, '../submodule/homeui/frontend/app/styles'),

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
