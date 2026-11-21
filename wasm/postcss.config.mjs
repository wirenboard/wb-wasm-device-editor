// homeui's CSS uses @custom-media from its breakpoints.css (homeui #1327);
// the same plugins, taken from homeui's own node_modules, resolve it here.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const homeuiFrontend = path.resolve(dirname, '../submodule/homeui/frontend');
const requireFromHomeui = createRequire(path.join(homeuiFrontend, 'package.json'));

const postcssGlobalData = requireFromHomeui('@csstools/postcss-global-data');
const postcssCustomMedia = requireFromHomeui('postcss-custom-media');
const autoprefixer = requireFromHomeui('autoprefixer');

export default {
  plugins: [
    postcssGlobalData({ files: [path.join(homeuiFrontend, 'src/common/breakpoints.css')] }),
    postcssCustomMedia(),
    autoprefixer(),
  ],
};
