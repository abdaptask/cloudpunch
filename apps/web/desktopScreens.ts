import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizePath, type Plugin } from 'vite';

/**
 * ADR-0033 §5: the web builds the desktop's Team screens from their
 * source, and wherever those import the desktop's `api.ts` (Tauri
 * calls) it gets `src/desktopApi.ts` (fetch to `/v1`) instead. Only that
 * one file is swapped; a desktop screen that needs a call the web
 * doesn't have fails the build ("not exported"), not at run time.
 */
// Vite's form of a path (forward slashes): a backslashed copy would be
// a second module, whose `connectApi` is never called.
const file = (rel: string): string =>
  normalizePath(path.resolve(fileURLToPath(new URL(rel, import.meta.url))));
const DESKTOP_API = file('../desktop/src/api.ts');
const WEB_API = file('./src/desktopApi.ts');

export function desktopScreens(): Plugin {
  return {
    name: 'cloudpunch-desktop-screens',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.endsWith('api.js')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalizePath(resolved.id) === DESKTOP_API ? WEB_API : null;
    },
  };
}
