import { localAssetPath } from './convert';

export interface AssetDownloadPlan {
  downloads: Array<{ source: string; local: string }>;
  collisions: string[];
}

/**
 * Two different legacy asset paths can collapse to the same local path once
 * localAssetPath() strips punctuation/whitespace runs. Plan one download per
 * local path (first source wins); record later collisions instead of
 * silently overwriting.
 */
export function planAssetDownloads(sources: Iterable<string>): AssetDownloadPlan {
  const downloads: Array<{ source: string; local: string }> = [];
  const collisions: string[] = [];
  const seenLocal = new Map<string, string>();

  for (const source of sources) {
    const local = localAssetPath(source);
    const existing = seenLocal.get(local);
    if (existing) {
      collisions.push(`${source} collides with ${existing} at ${local}`);
      continue;
    }
    seenLocal.set(local, source);
    downloads.push({ source, local });
  }

  return { downloads, collisions };
}
