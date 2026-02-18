import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Suppress noisy plugin messages about externalized modules
// These are expected for SSR builds and not actual problems
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

if (process.env.NODE_ENV === 'production' || process.argv.includes('build')) {
  const shouldSuppress = (message: string): boolean => {
    return (
      message.includes('externalized for browser compatibility') ||
      message.includes('[plugin:vite:resolve]') && message.includes('has been externalized') ||
      message.includes('[vite-plugin-svelte]') && message.includes('Unused CSS selector')
    );
  };

  console.error = (...args: any[]) => {
    const message = args.join(' ');
    if (shouldSuppress(message)) {
      return;
    }
    originalConsoleError.apply(console, args);
  };

  console.warn = (...args: any[]) => {
    const message = args.join(' ');
    if (shouldSuppress(message)) {
      return;
    }
    originalConsoleWarn.apply(console, args);
  };

  console.log = (...args: any[]) => {
    const message = args.join(' ');
    if (shouldSuppress(message)) {
      return;
    }
    originalConsoleLog.apply(console, args);
  };
}

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // Exclude Node.js-only modules from client bundle
    noExternal: [],
    external: [
      'simple-git',
      'child_process',
      'fs',
      'fs/promises',
      'path',
      'os',
      'crypto',
      'stream',
      'util',
      'events',
      'buffer'
    ]
  },
  optimizeDeps: {
    // Exclude server-only modules from pre-bundling
    exclude: [
      'src/lib/services/messaging/preferences-storage.ts',
      'simple-git'
    ]
  },
  build: {
    rollupOptions: {
      external: (id) => {
        // Externalize Node.js-only modules to prevent bundling for browser
        if (id === 'simple-git' || id.startsWith('simple-git/')) {
          return true;
        }
        // Externalize Node.js built-in modules
        if (
          id === 'child_process' ||
          id === 'fs' ||
          id === 'fs/promises' ||
          id === 'path' ||
          id === 'os' ||
          id === 'crypto' ||
          id === 'stream' ||
          id === 'util' ||
          id === 'events' ||
          id === 'buffer' ||
          id.startsWith('node:')
        ) {
          return true;
        }
        return false;
      },
      onwarn(warning, warn) {
        // Suppress warnings about externalized modules (expected for SSR builds)
        if (
          warning.code === 'MODULE_LEVEL_DIRECTIVE' ||
          (typeof warning.message === 'string' && 
           warning.message.includes('externalized for browser compatibility'))
        ) {
          return;
        }
        // Show other warnings
        warn(warning);
      }
    },
    // Increase chunk size warning limit to reduce noise
    chunkSizeWarningLimit: 2000
  },
  // Reduce log level to suppress INFO messages
  logLevel: 'warn'
});
