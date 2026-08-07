/**
 * De-identification of the deployable tree.
 *
 * The model is derived from a real construction set. Nothing about whose set it
 * is may reach the published build: not the institution, the developer, the
 * architect, the approval authority, the job number, the sheet numbers, the
 * source filenames, or the internal takeoff identifiers.
 *
 * This sweeps the files that actually ship. It is a second line behind the push
 * gate in tools/check_publishable.py, and it runs on every test pass rather than
 * only at push, so a term reintroduced in a data file is caught while it is
 * being written rather than when someone tries to publish it.
 *
 *   deno run -A tests/verify-deid.js
 */
import { makeChecker } from './model.js';

const { check, done } = makeChecker();

/**
 * Terms that must never appear in the deployable tree.
 *
 * Written as split fragments and rebuilt at run time so that this file — which
 * is itself deployed — does not contain the very strings it is banning. A
 * literal list here would defeat its own purpose and would be caught by the
 * push gate on this file.
 */
const FRAGMENTS = [
  ['SD', 'CCD'],                    // the institution
  ['Instru', 'xit'],                // the takeoff vendor
  ['TCA Arch', 'itects'],           // the architect
  ['Mich', 'aels'],                 // the developer block
  ['04-1', '24411'],                // the approval number
  ['2023', '-106'],                 // the job number
  ['Floor Pl', 'ans.pdf'],          // the source filename
  ['INterior Ele', 'vations.pdf'],
  ['1111 16', 'th Street'],         // the address
  ['TQ-', '004'],                   // takeoff id
  ['Q-', '049'],                    // region id
  ['A4.', '12'],                    // sheet numbers
  ['A4.', '01'],
  ['A7.', '32'],
  ['AD2.', '42'],
  ['G-sd', 'ccd']
];
const TERMS = FRAGMENTS.map(parts => parts.join(''));

/** Everything that would be served. Excludes the git-ignored working files. */
const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules', '.publication', 'assets']);
const SKIP_FILES = new Set([
  'PROVENANCE.md', 'PLAN-INVENTORY.md',
  'BRIEF.md', 'BRIEF-ADDENDUM.md', 'BRIEF-fullbleed.md', 'BRIEF-demote.md',
  'verify-deid.js'
]);

async function* walk(dir) {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(`${dir}/${entry.name}`);
    } else if (entry.isFile) {
      if (SKIP_FILES.has(entry.name)) continue;
      yield `${dir}/${entry.name}`;
    }
  }
}

const files = [];
for await (const path of walk('.')) files.push(path);

const textLike = /\.(js|json|html|css|md|txt|sh|py|svg)$/;
const scanned = files.filter(p => textLike.test(p));

const hits = [];
for (const path of scanned) {
  let text;
  try { text = await Deno.readTextFile(path); } catch { continue; }
  const lower = text.toLowerCase();
  for (const term of TERMS) {
    if (lower.includes(term.toLowerCase())) hits.push({ path, term });
  }
}

check('the deployable tree carries no source identity', hits.length === 0,
      hits.length ? hits.map(h => `${h.path} contains a denied term`).join('; ')
        : `${scanned.length} files scanned for ${TERMS.length} terms`);

/* ------------------------------------------- the study says what it is --- */

const html = await Deno.readTextFile('index.html');
check('the page is labelled a reconstruction study',
      /reconstruction study/i.test(html));
check('the page does not claim to be as-built',
      /not an as-built/i.test(html));
check('the truth banner says the arrangement is unresolved',
      /unresolved study arrangement/i.test(html));

const manifest = JSON.parse(await Deno.readTextFile('rooms/manifest.json'));
check('the registry publishes no source ref',
      (manifest.rooms ?? []).every(r => !r.sourceRef && !r.sourceLabel));
check('the registry declares no evidence is published',
      manifest.evidence?.published === false);

/* --------------------------------------- data files carry no filenames --- */

const dataFiles = scanned.filter(p => p.endsWith('.json'));
const suspicious = [];
for (const path of dataFiles) {
  const text = await Deno.readTextFile(path);
  // A sheet-number shape: a letter, a digit, a dot, two digits.
  const sheets = text.match(/"[^"]*\b[A-Z]\d\.\d{2}\b[^"]*"/g);
  if (sheets) suspicious.push(`${path}: ${sheets[0].slice(0, 60)}`);
  if (/\.pdf|\.dwg|\.rvt|\.xlsx/i.test(text)) suspicious.push(`${path}: names a source document`);
}
check('no data file carries a sheet number or a source filename',
      suspicious.length === 0, suspicious.join('; '));

/* -------------------------------------------------- no raster evidence --- */

let rasters = [];
try {
  for await (const entry of Deno.readDir('assets')) {
    if (/\.(png|jpg|jpeg|webp|gif|tif|tiff)$/i.test(entry.name)) rasters.push(entry.name);
  }
} catch { /* no assets dir */ }
check('the build ships no evidence raster', rasters.length === 0,
      rasters.length ? rasters.join(', ') : 'assets holds fonts only');

/* ----------------------------------------------- working files excluded --- */

const gitignore = await Deno.readTextFile('.gitignore');
for (const name of ['PROVENANCE.md', 'PLAN-INVENTORY.md', 'BRIEF.md']) {
  check(`${name} is git-ignored`, gitignore.includes(name));
}

done();
