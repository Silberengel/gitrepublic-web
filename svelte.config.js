import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    css: 'external'
  },
  onwarn(warning, handler) {
    // Suppress CSS unused selector warnings
    // These are false positives for dark theme selectors that are conditionally applied
    if (warning.code === 'css-unused-selector') {
      return;
    }
    handler(warning);
  },
  kit: {
    adapter: adapter()
  }
};

export default config;
