/**
 * A small typed client over the GitHub REST API, scoped to exactly what the CMS needs:
 * list the tree of a branch, read a file, write a file, delete a file.
 *
 * Every write is its own commit. The bot token owns the commit (`committer`), but the
 * signed-in editor is recorded as its `author`, so `git log` still says who changed what
 * even though no editor has a GitHub account.
 */
export type FetchImpl = typeof fetch;

export interface Author {
  name: string;
  email: string;
}

export interface GitHubFile {
  path: string;
  /** The git blob sha — needed to update or delete the file, and used as Decap's entry id. */
  sha: string;
  contentBase64: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
}

export interface GitHubContentClient {
  listTree(prefix: string): Promise<TreeEntry[]>;
  getFile(path: string): Promise<GitHubFile | null>;
  getRawFile(path: string): Promise<string | null>;
  putFile(
    path: string,
    contentBase64: string,
    message: string,
    options: { author: Author; sha?: string },
  ): Promise<{ sha: string }>;
  deleteFile(path: string, message: string, options: { author: Author; sha: string }): Promise<void>;
}

export interface GitHubClientConfig {
  /** `owner/repo` */
  repo: string;
  branch: string;
  token: string;
  fetchImpl?: FetchImpl;
}

/** The account that owns every commit; the editor is recorded as the author. */
export const COMMITTER: Author = { name: 'WSSL Site Editor', email: 'site-editor@wssl.org' };

const API = 'https://api.github.com';
const USER_AGENT = 'wssl-site-editor';

export class GitHubApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/* ---------------------------------------------------------------- base64 helpers */
// Workers have no Buffer, and `String.fromCharCode(...bytes)` overflows the stack on
// anything large, so both directions go through fixed-size chunks.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

/* ------------------------------------------------------------------------ client */

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createGitHubContentClient(config: GitHubClientConfig): GitHubContentClient {
  const { repo, branch, token, fetchImpl = fetch } = config;
  if (!repo.includes('/')) throw new GitHubApiError(`GITHUB_REPO must be "owner/repo", got "${repo}"`, 500);

  const headers = (accept = 'application/vnd.github+json') => ({
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  });

  /** Turns a non-2xx response into an error that says what failed without echoing the token. */
  async function fail(method: string, endpoint: string, response: Response): Promise<never> {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = `: ${body.message}`;
    } catch {
      /* a non-JSON error body tells us nothing useful */
    }
    throw new GitHubApiError(`GitHub ${method} ${endpoint} failed with ${response.status}${detail}`, response.status);
  }

  async function contentsJson(path: string): Promise<{ content?: string; encoding?: string; sha: string } | null> {
    const endpoint = `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
    const response = await fetchImpl(`${API}${endpoint}`, { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) return fail('GET', endpoint, response);
    const body = (await response.json()) as
      | { type?: string; content?: string; encoding?: string; sha: string }
      | unknown[];
    // A directory path answers with a JSON array, not an object — treat it as "no file".
    if (Array.isArray(body)) return null;
    if (body.type && body.type !== 'file') return null;
    return body;
  }

  async function rawBytes(path: string): Promise<Uint8Array | null> {
    const endpoint = `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
    const response = await fetchImpl(`${API}${endpoint}`, { headers: headers('application/vnd.github.raw') });
    if (response.status === 404) return null;
    if (!response.ok) return fail('GET', endpoint, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    async listTree(prefix: string): Promise<TreeEntry[]> {
      const endpoint = `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
      const response = await fetchImpl(`${API}${endpoint}`, { headers: headers() });
      if (response.status === 404) return [];
      if (!response.ok) return fail('GET', endpoint, response);
      const body = (await response.json()) as {
        tree?: { path: string; type: string; sha: string }[];
        truncated?: boolean;
      };
      // A truncated tree would silently hide entries from the editor; better to say so.
      if (body.truncated) {
        throw new GitHubApiError('The repository tree is too large to list in one request', 502);
      }
      return (body.tree ?? [])
        .filter((e) => e.type === 'blob' && (e.path === prefix || e.path.startsWith(`${prefix}/`)))
        .map((e) => ({ path: e.path, sha: e.sha }));
    },

    async getFile(path: string): Promise<GitHubFile | null> {
      const body = await contentsJson(path);
      if (!body) return null;
      // Files over 1 MB come back with no inline content; fetch the blob itself.
      if (body.encoding === 'base64' && typeof body.content === 'string' && body.content.length > 0) {
        return { path, sha: body.sha, contentBase64: body.content.replace(/\s+/g, '') };
      }
      const bytes = await rawBytes(path);
      if (!bytes) return null;
      return { path, sha: body.sha, contentBase64: bytesToBase64(bytes) };
    },

    async getRawFile(path: string): Promise<string | null> {
      const bytes = await rawBytes(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },

    async putFile(path, contentBase64, message, options) {
      const endpoint = `/repos/${repo}/contents/${encodePath(path)}`;
      const response = await fetchImpl(`${API}${endpoint}`, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: contentBase64,
          branch,
          committer: COMMITTER,
          author: options.author,
          ...(options.sha ? { sha: options.sha } : {}),
        }),
      });
      if (!response.ok) return fail('PUT', endpoint, response);
      const body = (await response.json()) as { content?: { sha?: string } };
      return { sha: body.content?.sha ?? '' };
    },

    async deleteFile(path, message, options) {
      const endpoint = `/repos/${repo}/contents/${encodePath(path)}`;
      const response = await fetchImpl(`${API}${endpoint}`, {
        method: 'DELETE',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          sha: options.sha,
          branch,
          committer: COMMITTER,
          author: options.author,
        }),
      });
      if (!response.ok) return fail('DELETE', endpoint, response);
    },
  };
}
