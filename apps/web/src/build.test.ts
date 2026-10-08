// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * The production build, not the test runner's module graph: the desktop
 * screens must get the browser `api` (ADR-0033 §5) as the very module
 * the app signs in, or every call answers "sign in again".
 */
describe('the web build', () => {
  it('gives the desktop screens the one signed-in browser api, and no Tauri', async () => {
    const out = (await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      logLevel: 'silent',
      build: { write: false, sourcemap: false, minify: false },
    })) as Rollup.RollupOutput;
    const js = out.output
      .filter((o): o is Rollup.OutputChunk => o.type === 'chunk')
      .map((c) => c.code)
      .join('\n');
    expect(js).toContain('/v1/team/connections');
    expect(js.match(/function connectApi\(/g)).toHaveLength(1);
    expect(js).not.toMatch(/__TAURI|@tauri-apps/);
  }, 60_000);
});
