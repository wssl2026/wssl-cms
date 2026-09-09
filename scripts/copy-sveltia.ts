/**
 * Vendors the Sveltia CMS bundle into `public/admin/`.
 *
 * `/admin` loads the editor from our own origin, never a CDN: a third-party script tag
 * would let someone else ship new code into the page that commits to the site. The copy
 * is git-ignored and rebuilt by `npm run build`, so the version in `package.json` — which
 * is pinned exactly, not a range — is the only place the editor's version is decided.
 *
 * The file has to keep the name `sveltia-cms.js`: the bundle looks itself up with
 * `script[src$="/sveltia-cms.js"]` to decide whether to initialize automatically.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';

const SOURCE = 'node_modules/@sveltia/cms/dist/sveltia-cms.js';
const TARGET = 'public/admin/sveltia-cms.js';

const declared = JSON.parse(readFileSync('package.json', 'utf8')).dependencies?.['@sveltia/cms'];
const installed = JSON.parse(readFileSync('node_modules/@sveltia/cms/package.json', 'utf8')).version;

if (!declared) {
  throw new Error('package.json does not depend on @sveltia/cms; /admin would have no editor to load.');
}
if (!/^\d+\.\d+\.\d+$/.test(declared)) {
  // A range would let `npm install` change the editor under a build nobody reviewed.
  throw new Error(`@sveltia/cms must be pinned to an exact version in package.json, not "${declared}".`);
}
if (declared !== installed) {
  throw new Error(`@sveltia/cms ${installed} is installed but package.json pins ${declared}. Run npm install.`);
}

mkdirSync('public/admin', { recursive: true });
copyFileSync(SOURCE, TARGET);

console.log(`copy-sveltia: ${TARGET} ← @sveltia/cms ${installed} (${statSync(TARGET).size} bytes)`);
