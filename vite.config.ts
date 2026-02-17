import path from 'path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import { fsPolyfillPlugin } from './config/vite-plugin-fs-polyfill'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // fs polyfill must come first
    fsPolyfillPlugin(),
    react(),
    nodePolyfills({
      // Enable polyfills for specific globals and modules
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Include other modules but not fs (we handle it with our plugin)
      // util is included to handle process.env.NODE_DEBUG properly
      include: ['path', 'crypto', 'stream', 'buffer', 'util', 'events'],
      // Explicitly enable protocolImports to handle Node.js built-ins
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    commonjsOptions: {
      // Transform CommonJS modules to ES6
      transformMixedEsModules: true,
      include: [/node_modules/],
    },
    // Strip console.log and console.debug in production builds
    minify: 'esbuild',
    target: 'es2020',
  },
  esbuild: {
    // Remove console.log and console.debug in production
    drop: process.env['NODE_ENV'] === 'production' ? ['console', 'debugger'] : [],
  },
  optimizeDeps: {
    exclude: [
      '@railgun-community/poseidon-hash-wasm',
      '@railgun-community/curve25519-scalarmult-wasm',
      'brotli-wasm', // Exclude brotli-wasm to prevent pre-bundling issues with WASM
    ],
    // Include snarkjs and its dependencies for proper bundling
    include: ['snarkjs', 'snarkjs > big-integer'],
    esbuildOptions: {
      // Define global for browser
      define: {
        global: 'globalThis',
      },
    },
  },
  // Handle WASM files properly
  assetsInclude: ['**/*.wasm'],
  define: {
    'process.browser': 'true',
    // Fix for util module trying to access process.env.NODE_DEBUG
    'process.env.NODE_DEBUG': 'undefined',
  },
  server: {
    port: 3000,
    host: true,
    // Enable SharedArrayBuffer for better WebAssembly memory management
    // This is CRITICAL for zk-SNARK proof generation in browsers
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
})
