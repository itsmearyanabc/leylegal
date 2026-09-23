import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_JS } from './app.js';

/**
 * The web app is a string, so the TypeScript compiler never parses it.
 *
 * A second `function setBusy` was added beside the existing one, and nothing
 * noticed: the typecheck and every other test passed. The page ships as a
 * module, where a repeated top-level declaration is a SyntaxError - so the
 * browser would have refused the whole script and every visitor would have
 * sat on the loading screen. Parsed here as a module, the way the browser
 * parses it.
 */
describe('the web app script', () => {
  it('parses as a module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-app-js-'));
    const file = join(dir, 'app.mjs');
    try {
      writeFileSync(file, APP_JS);
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
