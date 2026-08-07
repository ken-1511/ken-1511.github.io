/**
 * The shell's contract with the page.
 *
 * app.js reaches for elements by id and by data attribute. Nothing checks that
 * those exist until the browser runs, and a rename shows up as a null
 * dereference in the console rather than as a failure anyone sees. This is a
 * text check over both files, so it costs nothing and catches the whole class.
 *
 *   deno run -A tests/verify-wiring.js
 */
import { SHELL_MODES } from '../src/display.js';
import { VIEW_MODES } from '../src/room-viewer.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures += 1; console.log(`  FAIL  ${name}  ${detail}`); }
  else console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
};

const html = await Deno.readTextFile('index.html');
const app = await Deno.readTextFile('app.js');

const idsInPage = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const idsUsed = new Set([
  ...[...app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1])
]);

const missing = [...idsUsed].filter(id => !idsInPage.has(id));
check('every id the shell reaches for exists in the page', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${idsUsed.size} ids`);

// Selectors used for groups of controls, not single ids.
const groupSelectors = [...app.matchAll(/querySelectorAll\('([^']+)'\)/g)].map(m => m[1]);
for (const selector of groupSelectors) {
  const id = selector.match(/^#([A-Za-z0-9_-]+)\s/)?.[1];
  if (id) check(`group selector "${selector}" has a host`, idsInPage.has(id));
}

const shellButtons = [...html.matchAll(/data-shell="([^"]+)"/g)].map(m => m[1]);
check('a control exists for every shell mode',
      SHELL_MODES.every(mode => shellButtons.includes(mode)),
      shellButtons.join(', '));
check('no control offers a shell mode the viewer rejects',
      shellButtons.every(mode => SHELL_MODES.includes(mode)));

const viewButtons = [...html.matchAll(/data-mode="([^"]+)"/g)].map(m => m[1]);
check('a control exists for every view mode',
      VIEW_MODES.every(mode => viewButtons.includes(mode)), viewButtons.join(', '));
check('no control offers a view mode the viewer rejects',
      viewButtons.every(mode => VIEW_MODES.includes(mode)));

// The clip axis control has to speak the axis names clipPlaneSpec accepts.
const clipAxes = [...html.matchAll(/<option value="([xyz])"/g)].map(m => m[1]);
check('clip axis options are real axes', clipAxes.length === 3 && new Set(clipAxes).size === 3,
      clipAxes.join(', '));

// The live region and the no-WebGL path are load-bearing and easy to drop.
for (const id of ['srStatus', 'webglFallback', 'loadingState', 'routeError']) {
  check(`${id} survives`, idsInPage.has(id));
}

check('the page still declares an import map', html.includes('type="importmap"'));
check('no CDN reference crept in',
      !/https?:\/\/(?!www\.w3\.org)/i.test(html), 'strict offline');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
if (failures > 0) Deno.exit(1);
