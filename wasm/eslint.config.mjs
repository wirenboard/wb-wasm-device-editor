import baseConfig from '@wirenboard/eslint';
import reactConfig from '@wirenboard/eslint/react';

const getCustomConfig = (cfg) => {
  const customIgnores = [
    'dist-configurator/**',
    '.vite/**',
    'public/**',
  ];
  const { ignores, ...rest } = cfg.at(0);

  return [{ ...rest, ignores: [...ignores, ...customIgnores] }];
};

export default [
  ...getCustomConfig(baseConfig),
  ...getCustomConfig(reactConfig),
];
