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

import { Kind, parse, print, visit } from 'graphql/language';
import type {
  ArgumentNode,
  DocumentNode,
  FieldNode,
  ObjectFieldNode,
  ObjectValueNode,
  ValueNode,
} from 'graphql/language';

/** The only host this proxy ever forwards to. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * The only parts of the repository a commit assembled in the editor's browser may touch.
 * Everything else — `functions/`, `wrangler.toml`, `package.json`, the build config — is
 * off limits: this Worker runs whatever `functions/` contains, so a commit there is a
 * deploy of arbitrary code with every secret this site holds.
 */
export const ALLOWED_ROOTS = ['src/content/pages', 'src/data', 'public/uploads', 'public/images'];

/**
 * True when `path` is a plain, forward-slash-separated path that stays inside one of
 * `ALLOWED_ROOTS`: no leading slash (that would make it absolute rather than repo-relative),
 * no backslash (not how GitHub's API takes a path, and not how one would legitimately
 * arrive here), and no `.`, `..` or empty segment — those are how a path that *looks* like
 * it is under an allowed root escapes it.
 */
export function assertAllowedPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return ALLOWED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** A Git SHA-1: 40 hex characters, and the only "ref" that can never mean a moving branch. */
const SHA_RE = /^[0-9a-fA-F]{40}$/;

/** A ref may only be the one branch this site builds and deploys from, or a specific,
 * immutable commit — never another branch, however it is spelled. */
function isAllowedRef(ref: string, branch: string): boolean {
  return typeof ref === 'string' && ref.length > 0 && (ref === branch || SHA_RE.test(ref));
}

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
  /** The one branch this site builds and deploys from — the only ref a commit, a tree
   * listing or a GraphQL file read may name (besides a pinned commit SHA). */
  branch: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `owner/name` → an escaped regex fragment, so a repository named `a.b` matches literally. */
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyRequest(input: ClassifyInput): ProxyDecision {
  const { repo, email, search = '', branch = '' } = input;
  const method = input.method.toUpperCase();
  const path = normalizeApiPath(input.path);

  if (path === '/graphql') {
    if (method !== 'POST') return deny('GraphQL is only reachable with POST');
    return classifyGraphQL(input.body, repo, email, branch);
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
      const treeMatch = /^\/git\/trees\/([^/]+)$/.exec(rest);
      if (treeMatch) {
        const ref = treeMatch[1];
        // The character class rules out `%` (and everything else outside a plain ref name)
        // before the ref is even compared to the branch, so a percent-encoded traversal
        // like `main%2F..%2F..%2Fuser` is refused here rather than reaching GitHub as an
        // unexpected path segment.
        if (!/^[A-Za-z0-9._-]+$/.test(ref) || !isAllowedRef(ref, branch)) {
          return deny(`This branch is not the one the editor may read: ${ref}`);
        }
        return { kind: 'forward', path: `${path}${search}` };
      }
      if (/^\/git\/blobs\/[0-9a-fA-F]+$/.test(rest)) return { kind: 'forward', path: `${path}${search}` };
      return deny(`This part of the repository API is not available to the editor: ${rest}`);
    }
  }

  return deny(`${method} ${path} is not an endpoint the editor may use`);
}

// --- GraphQL ---------------------------------------------------------------------------

/**
 * GraphQL is validated on its **parsed AST**, never on the query text.
 *
 * The earlier version of this file matched the query with regular expressions, and that is
 * not something GraphQL's lexical rules will support: a comment (`file #anything\n(path:…)`)
 * or an insignificant comma may sit anywhere a space may, a field may be reached through a
 * fragment, and an argument may be a variable. Every one of those breaks a text scan while
 * meaning exactly what the scan was looking for. So the document is parsed with the
 * reference parser and the rules below are applied to nodes.
 *
 * The shapes this has to accept are every GraphQL request Sveltia 0.208.2's GitHub backend
 * builds — read out of the package's own sources, not guessed:
 *
 * - `git/github/repository.js:55` — `query($owner,$repo){ repository(owner:$owner,name:$repo)
 *   { defaultBranchRef { name } } }`
 * - `git/github/commits.js:26` — `… repository { ref(qualifiedName:$branch) { target {
 *   ... on Commit { history(first:1){ nodes { oid message } } } } } }`
 * - `git/github/files.js:54` — `… repository { content_N: object(oid:"<blob sha>") {
 *   ... on Blob { text isTruncated } } commit_N: ref(qualifiedName:$branch) { target {
 *   ... on Commit { history(first:1, path:"<path>") { nodes { author {…} committedDate } } } } } }`
 * - `git/github/commits.js:219` — `… repository { history_N: ref(qualifiedName:$branch) {
 *   target { ... on Commit { history(first:100, path:"<path>") { nodes {…} } } } } }`
 * - `git/github/deployment.js:97,122` — `… repository { ref(qualifiedName:$branch){…} }` and
 *   `… repository { commit_N: object(oid:"<commit sha>") { ... on Commit { … } } }`
 * - `git/github/commits.js:138` — `mutation($input: CreateCommitOnBranchInput!) {
 *   createCommitOnBranch(input:$input) { commit { oid committedDate
 *   file_N: file(path:"<path>") { oid } } } }`
 *
 * Not one of them defines a named fragment, and not one has more than a single root field,
 * so both are required here and anything else is refused. `defaultBranchRef`, `ref`,
 * `target`, `history`, `nodes`, `author`, `... on Commit` and `... on Blob` carry no path
 * or repository of their own and are allowed through untouched; the two fields that *do*
 * name a file — `object` and `file` — are the ones checked below.
 */

/** The one thing a caller learns about a refused document: that it was refused. */
const GRAPHQL_NOT_ACCEPTED = 'GraphQL not accepted';

const argOf = (field: FieldNode, name: string): ArgumentNode | undefined =>
  field.arguments?.find((argument) => argument.name.value === name);

/**
 * A literal string, or a variable this same request's `variables` object resolves to one.
 * Anything else — an int, an object, a variable that was not supplied — is `undefined`, and
 * every caller treats that as a refusal.
 */
function resolveString(value: ValueNode, variables: Record<string, unknown>): string | undefined {
  if (value.kind === Kind.STRING) return value.value;
  if (value.kind === Kind.VARIABLE) {
    const supplied = variables[value.name.value];
    return typeof supplied === 'string' ? supplied : undefined;
  }
  return undefined;
}

/**
 * An inline `ObjectValue` as plain JSON, so the same checks run on it as on an `input`
 * that arrived through `variables`. A `Variable` anywhere inside becomes `undefined` — a
 * value the checks below never accept — because nothing here could validate it: the
 * rewritten message has to be forwarded, and a variable's value is not part of the
 * literal it would be substituted into.
 */
function literalToJS(value: ValueNode): unknown {
  switch (value.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return value.value;
    case Kind.BOOLEAN:
      return value.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(value.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return value.values.map(literalToJS);
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name.value] = literalToJS(field.value);
      return out;
    }
    default:
      return undefined;
  }
}

/** The same `input` object value with its `message` replaced by the one we vouch for. */
function withRewrittenMessage(input: ObjectValueNode, headline: string, body: string): ObjectValueNode {
  const objectField = (name: string, value: string): ObjectFieldNode => ({
    kind: Kind.OBJECT_FIELD,
    name: { kind: Kind.NAME, value: name },
    value: { kind: Kind.STRING, value },
  });
  const message: ObjectFieldNode = {
    kind: Kind.OBJECT_FIELD,
    name: { kind: Kind.NAME, value: 'message' },
    value: {
      kind: Kind.OBJECT,
      fields: [objectField('headline', headline), objectField('body', body)],
    },
  };
  return { ...input, fields: [...input.fields.filter((f) => f.name.value !== 'message'), message] };
}

interface ScanContext {
  branch: string;
  isMutation: boolean;
  /** When set, a `file(path:)` selection may only name a path in this set. */
  changedPaths: Set<string> | null;
  variables: Record<string, unknown>;
}

/**
 * `object` is how a GraphQL request reaches a file's bytes: `object(expression: "<ref>:<path>")`
 * on the repository, and `object(oid: "<sha>")` on a blob or commit. Both are scoped here —
 * the expression to the production branch (or a pinned commit) and the content roots, the oid
 * to a real 40-character SHA, which is content-addressed and so cannot be aimed at a path.
 *
 * An `object` with *neither* argument is refused, and that is the load-bearing case: it is
 * `TreeEntry.object`, which is how `tree { entries { object { ... on Blob { text } } } }`
 * would read every file in the repository without ever naming one. Sveltia never selects it.
 */
function checkObjectField(field: FieldNode, ctx: ScanContext): ProxyDecision | undefined {
  const expression = argOf(field, 'expression');
  const oid = argOf(field, 'oid');

  if (expression) {
    // A commit's *result* has no legitimate reason to read a file by expression; Sveltia
    // reads back nothing but `file_N: file(path:) { oid }` on the paths it just wrote.
    if (ctx.isMutation) return deny('A commit may not read repository files back by expression');
    if (expression.value.kind !== Kind.STRING) {
      return deny('A file read must name its ref and path directly, not through a variable');
    }
    const value = expression.value.value;
    const sep = value.indexOf(':');
    const ref = sep === -1 ? '' : value.slice(0, sep);
    const filePath = sep === -1 ? '' : value.slice(sep + 1);
    if (!isAllowedRef(ref, ctx.branch)) {
      return deny('A file read must reference the production branch or a specific commit');
    }
    if (!assertAllowedPath(filePath)) {
      return deny(`This part of the repository is not available to the editor: ${filePath || '(empty path)'}`);
    }
    return undefined;
  }

  if (oid) {
    const sha = resolveString(oid.value, ctx.variables);
    if (!sha || !SHA_RE.test(sha)) return deny('An object read by oid must name a full 40-character SHA');
    return undefined;
  }

  return deny('An object selection must name what it reads, through expression or oid');
}

/**
 * `Commit.file(path: "…")` resolves a `TreeEntry` for any path in the resulting tree
 * regardless of what the rest of the request touched, and `object { ... on Blob { text } }`
 * under it returns that file's content — so every `file` selection must name a literal path
 * under the content roots, and on a commit, one of the paths that same commit is changing.
 */
function checkFileField(field: FieldNode, ctx: ScanContext): ProxyDecision | undefined {
  const args = field.arguments ?? [];
  const pathArg = args.length === 1 && args[0].name.value === 'path' ? args[0] : undefined;
  if (!pathArg || pathArg.value.kind !== Kind.STRING) {
    return deny('A file selection must name its path directly, not through a variable');
  }
  const filePath = pathArg.value.value;
  if (!assertAllowedPath(filePath)) {
    return deny(`This part of the repository is not available to the editor: ${filePath || '(empty path)'}`);
  }
  if (ctx.changedPaths && !ctx.changedPaths.has(filePath)) {
    return deny(`A file selection may only name a file this commit is changing: ${filePath}`);
  }
  return undefined;
}

/** Every `object` and `file` field anywhere in the document, wherever the parser found it. */
function scanFields(document: DocumentNode, ctx: ScanContext): ProxyDecision | undefined {
  let denial: ProxyDecision | undefined;
  visit(document, {
    Field(node: FieldNode) {
      if (denial) return false;
      const name = node.name.value;
      if (name === 'object') denial = checkObjectField(node, ctx);
      else if (name === 'file') denial = checkFileField(node, ctx);
      return denial ? false : undefined;
    },
  });
  return denial;
}

/**
 * A `repository(owner:, name:)` argument: a literal that must already be this site's, or a
 * variable that must either be absent (then it is pinned) or already be this site's.
 * `fetchGraphQL` fills `$owner`/`$repo` in from its own store when the caller omits them,
 * so pinning here is what makes the forwarded request scoped either way.
 */
function pinRepositoryArgument(
  argument: ArgumentNode | undefined,
  expected: string,
  variables: Record<string, unknown>,
): ProxyDecision | undefined {
  if (!argument) return deny('A GraphQL query must name the repository through its owner and name arguments');
  const value = argument.value;
  if (value.kind === Kind.STRING) {
    return value.value === expected ? undefined : deny('That repository is not this site');
  }
  if (value.kind === Kind.VARIABLE) {
    const name = value.name.value;
    const supplied = variables[name];
    if (supplied === undefined) {
      variables[name] = expected;
      return undefined;
    }
    return supplied === expected ? undefined : deny('That repository is not this site');
  }
  return deny('A GraphQL query must name the repository through its owner and name arguments');
}

function classifyGraphQL(rawBody: string | undefined, repo: string, email: string, branch: string): ProxyDecision {
  if (!rawBody) return deny('GraphQL request has no body');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return deny('GraphQL body is not JSON');
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') return deny('GraphQL body carries no query');

  let document: DocumentNode;
  try {
    // The parser's own message describes the document a caller already has; echoing it back
    // only tells an attacker how far their probe got, so nothing from it is reported.
    document = parse(parsed.query, { noLocation: true });
  } catch {
    return deny(GRAPHQL_NOT_ACCEPTED);
  }

  // One operation, no fragment definitions: Sveltia sends neither a second operation nor a
  // named fragment, and a fragment is a way to reach a field the checks below would
  // otherwise have to chase across definitions.
  if (document.definitions.length !== 1) return deny(GRAPHQL_NOT_ACCEPTED);
  const operation = document.definitions[0];
  if (operation.kind !== Kind.OPERATION_DEFINITION) return deny(GRAPHQL_NOT_ACCEPTED);
  if (operation.operation !== 'query' && operation.operation !== 'mutation') return deny(GRAPHQL_NOT_ACCEPTED);

  const selections = operation.selectionSet.selections;
  // Exactly one root field — an inline fragment at the root is refused with everything else,
  // since it is a second way to spell a root selection.
  if (selections.length !== 1 || selections[0].kind !== Kind.FIELD) {
    return deny('A GraphQL request may only ask for one root field');
  }
  const rootField = selections[0];
  const isMutation = operation.operation === 'mutation';

  const variables = isRecord(parsed.variables) ? { ...parsed.variables } : {};
  const [owner, name] = repo.split('/');

  if (!isMutation) {
    if (rootField.name.value !== 'repository') {
      return deny('A GraphQL query must read the configured repository through the $owner and $repo variables');
    }
    const ownerDenial = pinRepositoryArgument(argOf(rootField, 'owner'), owner, variables);
    if (ownerDenial) return ownerDenial;
    const nameDenial = pinRepositoryArgument(argOf(rootField, 'name'), name, variables);
    if (nameDenial) return nameDenial;

    const denial = scanFields(document, { branch, isMutation: false, changedPaths: null, variables });
    if (denial) return denial;

    return { kind: 'forward', path: '/graphql', body: JSON.stringify({ ...parsed, variables }) };
  }

  if (rootField.name.value !== 'createCommitOnBranch') {
    return deny('The only mutation the editor may run is createCommitOnBranch');
  }
  const args = rootField.arguments ?? [];
  if (args.length !== 1 || args[0].name.value !== 'input') {
    return deny('createCommitOnBranch takes one input and nothing else');
  }
  const inputValue = args[0].value;

  // Sveltia passes the commit through `$input`; an inline object literal is accepted too, and
  // is the one case where the forwarded query text is rebuilt rather than passed through.
  let inputVariable: string | undefined;
  let input: Record<string, unknown> | undefined;
  if (inputValue.kind === Kind.VARIABLE) {
    inputVariable = inputValue.name.value;
    const supplied = variables[inputVariable];
    if (isRecord(supplied)) input = { ...supplied };
  } else if (inputValue.kind === Kind.OBJECT) {
    const literal = literalToJS(inputValue);
    if (isRecord(literal)) input = literal;
  } else {
    return deny('A commit must name its input');
  }

  const commitBranch = input && isRecord(input.branch) ? input.branch : undefined;
  if (!input || !commitBranch) return deny('The commit names no branch');
  if (commitBranch.repositoryNameWithOwner !== repo) return deny('The commit is aimed at another repository');
  // I2: a commit may only land on the branch this site actually builds and deploys —
  // never another branch, however plausible-looking.
  if (commitBranch.branchName !== branch) return deny('The commit targets a branch the editor may not use');

  // The head the commit is built on is a commit SHA and nothing else; a ref name here would
  // let a stale or attacker-chosen branch decide what the commit replaces.
  if (typeof input.expectedHeadOid !== 'string' || !SHA_RE.test(input.expectedHeadOid)) {
    return deny('A commit must name the full 40-character SHA of the head it expects');
  }

  // C1: every file this commit touches must fall inside the editable content roots.
  // `createCommitOnBranch` takes the paths straight from the browser, so without this a
  // commit into `functions/` or `wrangler.toml` would be a deploy of arbitrary code.
  const fileChanges = isRecord(input.fileChanges) ? input.fileChanges : {};
  const additions = Array.isArray(fileChanges.additions) ? fileChanges.additions : [];
  const deletions = Array.isArray(fileChanges.deletions) ? fileChanges.deletions : [];
  const changedPaths = new Set<string>();
  for (const change of [...additions, ...deletions]) {
    const changePath = isRecord(change) ? change.path : undefined;
    if (!assertAllowedPath(changePath)) {
      const shown = typeof changePath === 'string' && changePath ? changePath : '(empty path)';
      return deny(`This part of the repository is not available to the editor: ${shown}`);
    }
    changedPaths.add(changePath);
  }
  for (const change of additions) {
    if (!isRecord(change) || typeof change.contents !== 'string') {
      return deny('A commit must carry the contents of every file it adds');
    }
  }

  // I4: the mutation's *result selection* is a second way to read repository content — see
  // `checkFileField` — so every `file(path: …)` it asks for must be one of the paths this
  // same commit is changing, the shape Sveltia's own `file_N: file(path: …) { oid }`
  // selections take.
  const denial = scanFields(document, { branch, isMutation: true, changedPaths, variables });
  if (denial) return denial;

  // `createCommitOnBranch` has no author or committer field — GitHub attributes the
  // commit to whoever the token belongs to, which is the bot. The editor is recorded in
  // a trailer instead, so `git log` still answers "who changed this". Any trailer the
  // browser sent is dropped first: only Access decides whose name goes on a commit.
  const suppliedMessage = isRecord(input.message) ? input.message : {};
  const headline =
    typeof suppliedMessage.headline === 'string' ? sanitizeHeadline(suppliedMessage.headline) : '';
  const suppliedBody = typeof suppliedMessage.body === 'string' ? stripCoAuthors(suppliedMessage.body) : '';
  const trailer = `Co-authored-by: ${email} <${email}>`;
  const body = suppliedBody ? `${suppliedBody}\n\n${trailer}` : trailer;

  if (inputVariable) {
    // Sveltia's shape: the query text is forwarded byte for byte, aliases and all, and only
    // the variable it reads the commit out of is rewritten.
    const message = {
      ...suppliedMessage,
      ...(typeof suppliedMessage.headline === 'string' ? { headline } : {}),
      body,
    };
    variables[inputVariable] = { ...input, message };
    return { kind: 'forward', path: '/graphql', body: JSON.stringify({ ...parsed, variables }) };
  }

  // The inline case: the message lives in the query text, so the validated document is
  // re-printed with the rewritten message rather than the caller's text being trusted.
  const rewritten = visit(document, {
    ObjectValue(node: ObjectValueNode) {
      return node === inputValue ? withRewrittenMessage(node, headline, body) : undefined;
    },
  });
  return {
    kind: 'forward',
    path: '/graphql',
    body: JSON.stringify({ ...parsed, query: print(rewritten), variables }),
  };
}

/**
 * M5: a headline is one line. Folded newlines mean text after a break could later read as
 * its own line once GitHub joins headline and body — exactly how a trailer would be
 * smuggled in — so every line break is collapsed to a space, and any `Co-authored-by:`
 * line within it is stripped the same way one in the body is.
 */
function sanitizeHeadline(headline: string): string {
  return headline
    .split(/\r\n|\r|\n/)
    .filter((line) => !/^\s*co-authored-by\s*:/i.test(line))
    .join(' ')
    .trim();
}

function stripCoAuthors(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\s*co-authored-by\s*:/i.test(line))
    .join('\n')
    .trim();
}
