/**
 * The rules the GitHub API proxy at `/api/cms/gh/*` runs on: what Sveltia CMS is allowed
 * to ask GitHub for, and what has to be rewritten on the way through. Pure functions, so
 * every rule is a test rather than a deployment.
 *
 * The allow-list is not a guess. It is every call Sveltia 0.208.2's GitHub backend can
 * make in the mode this site configures it for (`publish_mode: simple`, no Open
 * Authoring, no editorial workflow), read out of the package's own source:
 *
 * | Call                                            | Source                                        |
 * | ----------------------------------------------- | --------------------------------------------- |
 * | `GET /user`                                     | `git/shared/user.js` `fetchUserProfile`       |
 * | `GET /repos/:o/:r/collaborators/:login`         | `git/github/repository.js` `checkRepositoryAccess` |
 * | `GET /repos/:o/:r/git/trees/:ref?recursive=1`   | `git/github/files.js` `fetchFileList`         |
 * | `GET /repos/:o/:r/git/blobs/:sha`               | `git/github/files.js` `requestBlob`           |
 * | `POST /graphql`                                 | `git/shared/api.js` `fetchGraphQL`            |
 *
 * `GET /user/emails` and `GET /rate_limit` are allowed as well — the first answered from
 * here like `/user`, the second forwarded — because they are the harmless pair every
 * GitHub client reaches for eventually. This version of Sveltia calls neither.
 *
 * The tree read is scoped to a single ref segment, which covers a branch name without a
 * slash in it and any commit SHA — that is what `fetchFileList` asks for on this site's
 * `main`. A branch named `feature/x` would be refused, and would need this rule widened.
 *
 * Everything else in that backend — forks, pull requests, issues, refs, `dispatches`,
 * `merge-upstream`, `/user/repository_invitations` — belongs to Open Authoring or the
 * editorial workflow, neither of which this site turns on, so none of it is allowed
 * through. Sveltia commits with the GraphQL `createCommitOnBranch` mutation and never
 * touches `PUT /repos/:o/:r/contents/…` or `POST /repos/:o/:r/git/commits`, so those
 * write paths are refused too rather than left open for a body-rewriting rule that
 * nothing would ever exercise.
 */

/** The only host this proxy ever forwards to. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

export interface SyntheticUser {
  login: string;
  name: string;
  email: string;
  avatar_url: string;
  id: number;
  type: 'User';
}

export interface SyntheticEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export type ProxyDecision =
  /** Send this path (and body, when rewritten) upstream with the bot token. */
  | { kind: 'forward'; path: string; body?: string }
  /** Answer from here; the editor has no GitHub account for GitHub to describe. */
  | { kind: 'synthetic'; response: 'user' | 'emails' | 'collaborator' }
  /** Refuse. `reason` is for the caller's 403 body; it never contains a credential. */
  | { kind: 'deny'; reason: string };

export interface ClassifyInput {
  method: string;
  /** Path below `/api/cms/gh`, e.g. `/api/v3/repos/o/r/git/trees/main`. */
  path: string;
  /** Query string including the `?`, when there is one. */
  search?: string;
  /** `owner/name` of the one repository this editor may touch. */
  repo: string;
  /** The signed-in editor, recorded on commits. */
  email: string;
  /** The raw request body, for GraphQL. */
  body?: string;
}

/**
 * Sveltia derives its REST base from `api_root` by appending `/api/v3`, and its GraphQL
 * base by appending `/api/graphql` (`git/github/api.js`). Undo that here so the rest of
 * this module reasons in plain GitHub paths — and so a hand-run `curl /api/cms/gh/user`
 * hits exactly the same rules the browser does.
 */
export function normalizeApiPath(rawPath: string): string {
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (path === '/api/graphql') return '/graphql';
  if (path === '/api/v3' || path === '/api/v3/') return '/';
  if (path.startsWith('/api/v3/')) return path.slice('/api/v3'.length);
  return path;
}

/** The path as it reads in a log line: our repository is context, not news. */
export function repoRelativePath(path: string, repo: string): string {
  if (!repo) return path;
  const prefix = `/repos/${repo}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
}

/** A stable, small, non-secret number derived from the email (FNV-1a, 32-bit). */
function stableId(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Keep it comfortably inside a safe integer and away from 0, which reads as "unset".
  return (hash % 1_000_000_000) + 1;
}

/**
 * The `/user` response Sveltia expects, built from the Access identity. The editor has no
 * GitHub account, so nothing here comes from GitHub — and the bot token's own account,
 * which the upstream `/user` would describe, is never shown to the browser.
 */
export function synthesizeUser(email: string): SyntheticUser {
  const localPart = email.split('@')[0] ?? '';
  const login = localPart.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'editor';
  return { login, name: email, email, avatar_url: '', id: stableId(email), type: 'User' };
}

export function synthesizeEmails(email: string): SyntheticEmail[] {
  return [{ email, primary: true, verified: true }];
}

const deny = (reason: string): ProxyDecision => ({ kind: 'deny', reason });

/** `owner/name` → an escaped regex fragment, so a repository named `a.b` matches literally. */
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyRequest(input: ClassifyInput): ProxyDecision {
  const { repo, email, search = '' } = input;
  const method = input.method.toUpperCase();
  const path = normalizeApiPath(input.path);

  if (path === '/graphql') {
    if (method !== 'POST') return deny('GraphQL is only reachable with POST');
    return classifyGraphQL(input.body, repo, email);
  }

  // Anything with a query string that is not the tree listing is refused below anyway;
  // the search is only ever carried through on a forwarded REST read.
  const repoPrefix = new RegExp(`^/repos/${escapeRe(repo)}/`);

  if (method === 'GET') {
    if (path === '/user') return { kind: 'synthetic', response: 'user' };
    if (path === '/user/emails') return { kind: 'synthetic', response: 'emails' };
    if (path === '/rate_limit') return { kind: 'forward', path: `/rate_limit${search}` };

    if (repoPrefix.test(path)) {
      const rest = path.slice(`/repos/${repo}`.length);
      // `checkRepositoryAccess` asks whether the signed-in login can write here. There is
      // no GitHub login to ask about — Access already decided — so answer it here rather
      // than forward a question about the bot's account.
      if (/^\/collaborators\/[^/]+$/.test(rest)) return { kind: 'synthetic', response: 'collaborator' };
      if (/^\/git\/trees\/[^/]+$/.test(rest)) return { kind: 'forward', path: `${path}${search}` };
      if (/^\/git\/blobs\/[0-9a-fA-F]+$/.test(rest)) return { kind: 'forward', path: `${path}${search}` };
      return deny(`This part of the repository API is not available to the editor: ${rest}`);
    }
  }

  return deny(`${method} ${path} is not an endpoint the editor may use`);
}

// --- GraphQL ---------------------------------------------------------------------------

/**
 * Sveltia's queries all have exactly one root field, and it is always parameterised by the
 * `$owner`/`$repo` variables this proxy pins (`git/github/{files,commits,repository,
 * deployment}.js`). Requiring that shape — rather than scanning for suspicious substrings
 * — is what keeps a query from reaching a second repository, the `viewer`, or an org.
 */
const QUERY_ROOT_RE = /^\s*query\s*(?:\([^)]*\))?\s*\{\s*repository\s*\(\s*owner\s*:\s*\$owner\s*,\s*name\s*:\s*\$repo\s*\)\s*\{/;
const MUTATION_ROOT_RE = /^\s*mutation\s*\(\s*\$input\s*:\s*CreateCommitOnBranchInput!\s*\)\s*\{\s*createCommitOnBranch\s*\(\s*input\s*:\s*\$input\s*\)\s*\{/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when the `{` at `start` closes with nothing but whitespace and closing braces after
 * it — i.e. the selection it opens is the query's only root field. String literals are
 * stepped over so a brace inside a file path cannot unbalance the count.
 */
function isOnlyRootSelection(query: string, start: number): boolean {
  let depth = 0;
  let i = start;
  for (; i < query.length; i += 1) {
    const char = query[i];
    if (char === '"') {
      i += 1;
      while (i < query.length && query[i] !== '"') i += query[i] === '\\' ? 2 : 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return false;
  return /^[\s}]*$/.test(query.slice(i + 1));
}

function classifyGraphQL(rawBody: string | undefined, repo: string, email: string): ProxyDecision {
  if (!rawBody) return deny('GraphQL request has no body');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return deny('GraphQL body is not JSON');
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') return deny('GraphQL body carries no query');

  const query = parsed.query;
  const isMutation = /^\s*mutation\b/.test(query);
  const root = isMutation ? MUTATION_ROOT_RE : QUERY_ROOT_RE;
  const match = root.exec(query);
  if (!match) {
    return deny(
      isMutation
        ? 'The only mutation the editor may run is createCommitOnBranch'
        : 'A GraphQL query must read the configured repository through the $owner and $repo variables',
    );
  }
  if (!isOnlyRootSelection(query, match[0].length - 1)) {
    return deny('A GraphQL request may only ask for one root field');
  }

  const variables = isRecord(parsed.variables) ? { ...parsed.variables } : {};
  const [owner, name] = repo.split('/');

  if ('owner' in variables && variables.owner !== owner) return deny('That repository owner is not this site');
  if ('repo' in variables && variables.repo !== name) return deny('That repository is not this site');
  // `fetchGraphQL` fills these in from its own store when they are absent; pin them here
  // so the forwarded request is scoped whether or not the browser sent them.
  if (query.includes('$owner')) variables.owner = owner;
  if (query.includes('$repo')) variables.repo = name;

  if (isMutation) {
    const input = isRecord(variables.input) ? { ...variables.input } : undefined;
    const branch = input && isRecord(input.branch) ? input.branch : undefined;
    if (!input || !branch) return deny('The commit names no branch');
    if (branch.repositoryNameWithOwner !== repo) return deny('The commit is aimed at another repository');

    // `createCommitOnBranch` has no author or committer field — GitHub attributes the
    // commit to whoever the token belongs to, which is the bot. The editor is recorded in
    // a trailer instead, so `git log` still answers "who changed this". Any trailer the
    // browser sent is dropped first: only Access decides whose name goes on a commit.
    const message = isRecord(input.message) ? { ...input.message } : {};
    const supplied = typeof message.body === 'string' ? stripCoAuthors(message.body) : '';
    const trailer = `Co-authored-by: ${email} <${email}>`;
    message.body = supplied ? `${supplied}\n\n${trailer}` : trailer;
    input.message = message;
    variables.input = input;
  }

  return { kind: 'forward', path: '/graphql', body: JSON.stringify({ ...parsed, variables }) };
}

function stripCoAuthors(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\s*co-authored-by\s*:/i.test(line))
    .join('\n')
    .trim();
}
