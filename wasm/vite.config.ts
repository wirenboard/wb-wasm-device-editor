import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import commonjs from 'vite-plugin-commonjs';
import svgr from 'vite-plugin-svgr';

const homeuiNodeModules = path.resolve(__dirname, '../submodule/homeui/frontend/node_modules');


export default defineConfig(() => {
  return {
    plugins: [
      react(),
      commonjs(),
      svgr({ include: '**/*.svg' }),
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
        'i18next': path.resolve(homeuiNodeModules, 'i18next'),
        'classnames': path.resolve(homeuiNodeModules, 'classnames'),
        'mobx': path.resolve(homeuiNodeModules, 'mobx'),
        'mobx-react-lite': path.resolve(homeuiNodeModules, 'mobx-react-lite'),
      },
    },
    dedupe: ['react', 'react-dom'],
  };
});
