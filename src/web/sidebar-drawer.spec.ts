import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * On a phone the sidebar is a drawer over a dimming scrim, and tapping a past
 * conversation did nothing: the tap landed on the scrim. #app keeps a stacking
 * context from its fade-in (animation fill-mode `both`), so the drawer's
 * z-index 40 only ranked inside #app, and a scrim appended to <body> at
 * z-index 35 sat above all of #app, the open drawer included.
 *
 * Measured on the live stylesheet at 375x812 with elementFromPoint: a tap on a
 * thread hit the scrim; with the scrim inside #app it hits the thread button,
 * and a tap beside the drawer still hits the scrim.
 */
describe('the mobile drawer', () => {
  const app = readFileSync(join(process.cwd(), 'src/web/assets/app.js.ts'), 'utf8');
  const toggle = app.slice(app.indexOf('function toggleSidebar()'), app.indexOf('// Threads'));

  it('puts the scrim inside #app, beside the drawer, not on <body>', () => {
    expect(toggle).toContain("$('#app').appendChild(scrim)");
    expect(toggle).not.toContain('document.body.appendChild(scrim)');
  });
});
