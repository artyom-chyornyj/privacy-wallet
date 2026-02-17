/**
 * Vite plugin: Node.js `fs` and `constants` polyfills for the browser.
 *
 * Why this exists:
 *   snarkjs  ->  ejs        ->  requires `fs.readFileSync`
 *   snarkjs  ->  fastfile   ->  requires POSIX file-open constants (O_RDONLY, etc.)
 *
 * Neither module actually reads files in the browser — ejs falls back to
 * inline templates and fastfile uses ArrayBuffer — but the imports still need
 * to resolve. This plugin intercepts `import 'fs'` / `import 'constants'`
 * at build time and returns lightweight no-op stubs.
 */
import type { Plugin } from 'vite'

// ── Stub code that gets injected in place of real modules ────────────

const FS_STUB = `
export const readFileSync = (_path, enc) => enc ? '' : new Uint8Array();
export const existsSync   = () => false;
export const statSync      = () => ({ isFile: () => false, isDirectory: () => false });
export const readdirSync   = () => [];
export const readFile      = (_path, ...a) => { const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, ''); };
export default { readFileSync, existsSync, statSync, readdirSync, readFile };
`

const CONSTANTS_STUB = `
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR   = 2;
export const O_CREAT  = 64;
export const O_EXCL   = 128;
export const O_TRUNC  = 512;
export const O_APPEND = 1024;
export const O_SYNC   = 4096;
export default { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_SYNC };
`

// ── Plugin ───────────────────────────────────────────────────────────

const VIRTUAL_FS = '\0polyfill:fs'
const VIRTUAL_CONSTANTS = '\0polyfill:constants'

/**
 * Creates a Vite plugin that replaces `fs` and `constants` imports with browser-safe stubs.
 * @returns Vite plugin configuration
 */
export function fsPolyfillPlugin (): Plugin {
  return {
    name: 'node-fs-constants-polyfill',
    enforce: 'pre',

    /**
     * Intercepts `fs` and `constants` imports, redirecting them to virtual modules.
     * @param id - The module specifier being resolved
     * @returns Virtual module ID or null if not handled
     */
    resolveId (id) {
      if (id === 'fs' || id === 'node:fs') return VIRTUAL_FS
      if (id === 'constants' || id === 'node:constants') return VIRTUAL_CONSTANTS
      return null
    },

    /**
     * Returns stub source code for the virtual `fs` and `constants` modules.
     * @param id - The resolved module ID
     * @returns Stub module source or null if not a virtual module
     */
    load (id) {
      if (id === VIRTUAL_FS) return FS_STUB
      if (id === VIRTUAL_CONSTANTS) return CONSTANTS_STUB
      return null
    },
  }
}
