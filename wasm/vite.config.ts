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

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      commonjs(),
      svgr({ include: '**/*.svg' }),
      swCachePlugin(),
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
