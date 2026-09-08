/**
 * The Decap CMS "proxy backend" protocol, implemented against a GitHub repository.
 *
 * Decap's browser client POSTs `{ branch, action, params }` and is unforgiving about the
 * response shapes, so these mirror `decap-server`'s own local-filesystem middleware
 * (decap-server 3.11.1, `src/middlewares/localFs/index.ts` and `utils/entries.ts`):
 *
 *   entry      → { data: <file text> | null, file: { path, label?, id: <sha> | null } }
 *   media file → { id, content: <base64>, encoding: 'base64', path, name }
 *
 * Two deliberate departures from `decap-server`:
 *   - the entry/media `id` is the git blob sha rather than a sha256 of the content
 *     (Decap only needs a stable identifier, and the blob sha comes free with the read);
 *   - every path is checked against ALLOWED_ROOTS, because unlike a developer's local
 *     checkout this proxy is reachable by anyone who can sign in to the editor.
 */
import type { Author, GitHubContentClient } from './github-content';
import { base64ToUtf8, utf8ToBase64 } from './github-content';

/** The only places in the repository an editor may read or write. */
export const ALLOWED_ROOTS = ['src/content/pages', 'src/data', 'public/uploads'] as const;

export class ProxyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

export interface ProxyDeps {
  github: GitHubContentClient;
  /** `owner/repo`, reported by the `info` action. */
  repo: string;
  /** The signed-in editor, recorded as the git author of every commit. */
  author: Author;
}

export interface Entry {
  data: string | null;
  file: { path: string; label?: string; id: string | null };
}

export interface MediaFile {
  id: string;
  content: string;
  encoding: 'base64';
  path: string;
  name: string;
}

/* -------------------------------------------------------------------- validation */

function badRequest(message: string): ProxyError {
  return new ProxyError(message, 400);
}

/**
 * Accepts a repository-relative path under one of ALLOWED_ROOTS. Anything else — a
 * traversal, an absolute path, a backslash, a root that merely shares a prefix — is a
 * 400 rather than a read or write.
 */
export function assertAllowedPath(path: unknown, field = 'path'): string {
  if (typeof path !== 'string' || path.length === 0) throw badRequest(`${field} is required`);
  if (path.includes('\\')) throw badRequest(`${field} must not contain backslashes: ${path}`);
  if (path.startsWith('/')) throw badRequest(`${field} must be repository-relative: ${path}`);
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw badRequest(`${field} must not contain "." or ".." segments: ${path}`);
  }
  const allowed = ALLOWED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
  if (!allowed) throw badRequest(`${field} is outside the editable content folders: ${path}`);
  return path;
}

function asObject(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) throw badRequest(`${key} is required`);
  return value;
}

function commitMessage(params: Record<string, unknown>): string {
  const options = asObject(params.options);
  const message = options.commitMessage;
  if (typeof message !== 'string' || message.length === 0) throw badRequest('options.commitMessage is required');
  return message;
}

interface DataFile {
  path: string;
  raw: string;
  newPath?: string;
}

function readDataFiles(params: Record<string, unknown>): DataFile[] {
  // Decap 3.16 sends `dataFiles`; `entry` is the older single-file form the proxy
  // protocol still allows, and decap-server still accepts both.
  const raw = Array.isArray(params.dataFiles) ? params.dataFiles : params.entry ? [params.entry] : [];
  if (raw.length === 0) throw badRequest('persistEntry requires entry or dataFiles');
  return raw.map((candidate) => {
    const file = asObject(candidate);
    if (typeof file.raw !== 'string') throw badRequest('dataFiles[].raw is required');
    const path = assertAllowedPath(file.path, 'dataFiles[].path');
    const newPath = file.newPath === undefined ? undefined : assertAllowedPath(file.newPath, 'dataFiles[].newPath');
    return { path, raw: file.raw, newPath };
  });
}

interface Asset {
  path: string;
  content: string;
}

function readAsset(candidate: unknown, field: string): Asset {
  const asset = asObject(candidate);
  const path = assertAllowedPath(asset.path, `${field}.path`);
  if (typeof asset.content !== 'string') throw badRequest(`${field}.content is required`);
  if (asset.encoding !== 'base64') throw badRequest(`${field}.encoding must be base64`);
  return { path, content: asset.content };
}

/* ------------------------------------------------------------------------ shapes */

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function readEntry(github: GitHubContentClient, path: string, label?: string): Promise<Entry> {
  const file = await github.getFile(path);
  if (!file) return { data: null, file: { path, label, id: null } };
  return { data: base64ToUtf8(file.contentBase64), file: { path, label, id: file.sha } };
}

async function readMediaFile(github: GitHubContentClient, path: string): Promise<MediaFile> {
  const file = await github.getFile(path);
  if (!file) throw new ProxyError(`No file at ${path}`, 404);
  return { id: file.sha, content: file.contentBase64, encoding: 'base64', path, name: fileName(path) };
}

/**
 * Mirrors decap-server's `listRepoFiles`: `depth` counts directory levels below
 * `folder` (depth 1 = direct children), and `extension` is matched with `endsWith`,
 * exactly as the local proxy does.
 */
function withinDepth(folder: string, path: string, depth: number): boolean {
  const relative = path.slice(folder.length + 1);
  return relative.split('/').length <= depth;
}

/* ----------------------------------------------------------------------- actions */

export async function handleProxyAction(action: string, rawParams: unknown, deps: ProxyDeps): Promise<unknown> {
  const { github, repo, author } = deps;
  const params = asObject(rawParams);

  switch (action) {
    case 'info':
      // Decap's detectProxyServer() needs repo/publish_modes/type before it will use us.
      return { repo, publish_modes: ['simple'], type: 'github' };

    case 'entriesByFolder': {
      const folder = assertAllowedPath(params.folder, 'folder');
      const extension = typeof params.extension === 'string' ? params.extension : '';
      const depth = typeof params.depth === 'number' && params.depth > 0 ? params.depth : 1;
      const files = (await github.listTree(folder)).filter(
        (entry) => entry.path.endsWith(extension) && withinDepth(folder, entry.path, depth),
      );
      const entries: Entry[] = [];
      for (const file of files) entries.push(await readEntry(github, file.path));
      return entries;
    }

    case 'entriesByFiles': {
      const files = Array.isArray(params.files) ? params.files : undefined;
      if (!files) throw badRequest('files is required');
      const requested = files.map((candidate) => {
        const file = asObject(candidate);
        return {
          path: assertAllowedPath(file.path, 'files[].path'),
          label: typeof file.label === 'string' ? file.label : undefined,
        };
      });
      const entries: Entry[] = [];
      for (const file of requested) entries.push(await readEntry(github, file.path, file.label));
      return entries;
    }

    case 'getEntry':
      return readEntry(github, assertAllowedPath(params.path));

    case 'unpublishedEntries':
      // publish_mode is 'simple': nothing is ever in an editorial-workflow branch.
      return [];

    case 'persistEntry': {
      const message = commitMessage(params);
      const dataFiles = readDataFiles(params);
      const assetList = Array.isArray(params.assets) ? params.assets : [];
      const assets = assetList.map((asset, i) => readAsset(asset, `assets[${i}]`));

      // Sequential on purpose: GitHub rejects concurrent commits to the same branch.
      for (const dataFile of dataFiles) {
        const target = dataFile.newPath ?? dataFile.path;
        const existing = await github.getFile(target);
        await github.putFile(target, utf8ToBase64(dataFile.raw), message, {
          author,
          ...(existing ? { sha: existing.sha } : {}),
        });
        if (dataFile.newPath && dataFile.newPath !== dataFile.path) {
          const old = await github.getFile(dataFile.path);
          if (old) await github.deleteFile(dataFile.path, message, { author, sha: old.sha });
        }
      }
      for (const asset of assets) {
        const existing = await github.getFile(asset.path);
        await github.putFile(asset.path, asset.content, message, {
          author,
          ...(existing ? { sha: existing.sha } : {}),
        });
      }
      return { message: 'entry persisted' };
    }

    case 'getMedia': {
      const mediaFolder = assertAllowedPath(params.mediaFolder, 'mediaFolder');
      const files = (await github.listTree(mediaFolder)).filter((f) => withinDepth(mediaFolder, f.path, 1));
      const media: MediaFile[] = [];
      for (const file of files) media.push(await readMediaFile(github, file.path));
      return media;
    }

    case 'getMediaFile':
      return readMediaFile(github, assertAllowedPath(params.path));

    case 'persistMedia': {
      const message = commitMessage(params);
      const asset = readAsset(params.asset, 'asset');
      const existing = await github.getFile(asset.path);
      const { sha } = await github.putFile(asset.path, asset.content, message, {
        author,
        ...(existing ? { sha: existing.sha } : {}),
      });
      return {
        id: sha,
        content: asset.content,
        encoding: 'base64',
        path: asset.path,
        name: fileName(asset.path),
      } satisfies MediaFile;
    }

    case 'deleteFile': {
      const message = commitMessage(params);
      const path = assertAllowedPath(params.path);
      await deletePath(github, path, message, author);
      return { message: `deleted file ${path}` };
    }

    case 'deleteFiles': {
      const message = commitMessage(params);
      const rawPaths = Array.isArray(params.paths) ? params.paths : undefined;
      if (!rawPaths || rawPaths.length === 0) throw badRequest('paths is required');
      const paths = rawPaths.map((p, i) => assertAllowedPath(p, `paths[${i}]`));
      for (const path of paths) await deletePath(github, path, message, author);
      return { message: `deleted files ${paths.join(', ')}` };
    }

    case 'getDeployPreview':
      // Cloudflare Pages rebuilds on push; there is no per-entry preview to link to.
      return null;

    default:
      throw new ProxyError(`Unknown action ${action}`, 422);
  }
}

/** Deleting something already gone is a success, as it is on the local proxy. */
async function deletePath(github: GitHubContentClient, path: string, message: string, author: Author): Promise<void> {
  const existing = await github.getFile(path);
  if (!existing) return;
  await github.deleteFile(path, message, { author, sha: existing.sha });
}
