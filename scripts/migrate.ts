import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fetchAllContent, targetFor, frontmatter, buildNav, type MuraItem } from './lib/mura';
import { htmlToMarkdown, localAssetPath } from './lib/convert';
import { planAssetDownloads } from './lib/assets';
import { buildRedirectsFile } from './lib/redirects';

const THEME_IMAGES: Record<string, string> = {
  'https://www.wssl.org/sites/wssl/themes/wssl-theme/images/wssl-header-lg.png': 'public/images/wssl-header-lg.png',
  'https://www.wssl.org/sites/wssl/themes/wssl-theme/images/mobile-logo.png': 'public/images/mobile-logo.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-1.png': 'public/images/carousel-1.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-2.png': 'public/images/carousel-2.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-3.png': 'public/images/carousel-3.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-4.png': 'public/images/carousel-4.png',
};

async function download(url: string, dest: string): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function downloadLegacyAsset(assetPath: string): Promise<'ok' | 'missing'> {
  const dest = join('public', localAssetPath(assetPath));
  for (const host of ['https://www.wssl.org', 'https://cms.wssl.org']) {
    if (await download(host + assetPath, dest)) return 'ok';
  }
  return 'missing';
}

async function main() {
  const items = await fetchAllContent();
  const report = {
    written: [] as string[],
    skipped: [] as string[],
    assetsOk: [] as string[],
    assetsMissing: [] as string[],
    collisions: [] as string[],
  };
  const allAssets = new Set<string>();

  for (const item of items) {
    if (item.filename === '' || item.filename === 'index') {
      const { markdown } = htmlToMarkdown(item.body ?? '');
      await mkdir('src/data', { recursive: true });
      await writeFile('src/data/home-legacy.md', markdown + '\n');
      report.written.push('src/data/home-legacy.md');
      continue;
    }
    const target = targetFor(item.filename);
    if (!target || item.type !== 'Page') {
      report.skipped.push(`${item.type}:${item.filename}`);
      continue;
    }
    const { markdown, assets } = htmlToMarkdown(item.body ?? '');
    assets.forEach((a) => allAssets.add(a));
    const out = join('src/content/pages', target.file);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, frontmatter(item as MuraItem, target.path) + '\n' + markdown + '\n');
    report.written.push(out);
  }

  const { downloads, collisions } = planAssetDownloads(allAssets);
  report.collisions.push(...collisions);

  await writeFile('public/_redirects', buildRedirectsFile(downloads));

  for (const { source } of downloads) {
    (await downloadLegacyAsset(source)) === 'ok' ? report.assetsOk.push(source) : report.assetsMissing.push(source);
  }
  for (const [url, dest] of Object.entries(THEME_IMAGES)) {
    (await download(url, dest)) ? report.assetsOk.push(url) : report.assetsMissing.push(url);
  }

  await mkdir('src/data', { recursive: true });
  await writeFile('src/data/nav.json', JSON.stringify({ items: buildNav(items) }, null, 2) + '\n');
  await writeFile('scripts/migration-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`written=${report.written.length} skipped=${report.skipped.length} assetsOk=${report.assetsOk.length} assetsMissing=${report.assetsMissing.length} collisions=${report.collisions.length}`);
  console.log('skipped:', report.skipped.join(', '));
  console.log('missing assets:', report.assetsMissing.join(', '));
  console.log('collisions:', report.collisions.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
