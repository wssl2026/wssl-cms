import { describe, it, expect } from 'vitest';
import {
  GITHUB_API_ORIGIN,
  classifyRequest,
  normalizeApiPath,
  repoRelativePath,
  synthesizeEmails,
  synthesizeUser,
} from '../functions/_lib/github-proxy';

const REPO = 'wssl2026/wssl-cms';
const EMAIL = 'jane.doe@wssl.org';

/** The shape every test starts from; individual tests override what they are about. */
const BRANCH = 'main';

function ask(overrides: Partial<Parameters<typeof classifyRequest>[0]> = {}) {
  return classifyRequest({ method: 'GET', path: '/user', repo: REPO, branch: BRANCH, email: EMAIL, ...overrides });
}

/** Sveltia's REST calls arrive under `/api/v3`; its GraphQL calls under `/api/graphql`. */
const rest = (path: string) => `/api/v3${path}`;

describe('normalizeApiPath', () => {
  it('strips the /api/v3 prefix Sveltia derives from api_root', () => {
    expect(normalizeApiPath('/api/v3/repos/o/r/git/trees/main')).toBe('/repos/o/r/git/trees/main');
    expect(normalizeApiPath('api/v3/user')).toBe('/user');
  });
  it('maps the /api/graphql endpoint onto GitHub /graphql', () => {
    expect(normalizeApiPath('/api/graphql')).toBe('/graphql');
    expect(normalizeApiPath('api/graphql')).toBe('/graphql');
  });
  it('leaves a bare GitHub path alone, so curl and the browser agree', () => {
    expect(normalizeApiPath('/user')).toBe('/user');
    expect(normalizeApiPath('user')).toBe('/user');
    expect(normalizeApiPath('/graphql')).toBe('/graphql');
    expect(normalizeApiPath('')).toBe('/');
  });
  it('collapses nothing else — /api/v3 alone is just the root', () => {
    expect(normalizeApiPath('/api/v3')).toBe('/');
    expect(normalizeApiPath('/api/v3/')).toBe('/');
  });
  it('resolves nothing itself, so dot segments never reach the allow-list as a repo path', () => {
    expect(normalizeApiPath('/api/v3/../../orgs/secret')).toBe('/../../orgs/secret');
    for (const path of ['/api/v3/../../orgs/secret', `/api/v3/repos/${REPO}/../../users/octocat`]) {
      expect(classifyRequest({ method: 'GET', path, repo: REPO, branch: BRANCH, email: EMAIL }).kind).toBe('deny');
    }
  });
});

describe('synthesized identity', () => {
  it('builds a GitHub-shaped user out of the Access email, with no GitHub account behind it', () => {
    const user = synthesizeUser(EMAIL);
    // A GitHub login has no dots in it, so the local part is folded into one.
    expect(user).toMatchObject({ login: 'jane-doe', name: EMAIL, email: EMAIL, avatar_url: '' });
    expect(typeof user.id).toBe('number');
    expect(Number.isInteger(user.id)).toBe(true);
  });
  it('gives the same editor the same id every time, and different editors different ids', () => {
    expect(synthesizeUser(EMAIL).id).toBe(synthesizeUser(EMAIL).id);
    expect(synthesizeUser('a@wssl.org').id).not.toBe(synthesizeUser('b@wssl.org').id);
  });
  it('keeps the login to characters GitHub would accept in a login', () => {
    expect(synthesizeUser('Bob O\'Neill+tag@wssl.org').login).toMatch(/^[A-Za-z0-9-]+$/);
    expect(synthesizeUser('@@@@@@@@@@@@@@@@@@@@').login).not.toBe('');
  });
  it('reports the Access email as the one verified primary address', () => {
    expect(synthesizeEmails(EMAIL)).toEqual([{ email: EMAIL, primary: true, verified: true }]);
  });
});

describe('classifyRequest — the endpoints Sveltia actually calls', () => {
  it('answers GET /user itself and never forwards it', () => {
    expect(ask({ path: rest('/user') })).toEqual({ kind: 'synthetic', response: 'user' });
    expect(ask({ path: '/user' })).toEqual({ kind: 'synthetic', response: 'user' });
  });
  it('answers GET /user/emails itself', () => {
    expect(ask({ path: rest('/user/emails') })).toEqual({ kind: 'synthetic', response: 'emails' });
  });
  it('answers the collaborator check itself — the editor has no GitHub account to check', () => {
    expect(ask({ path: rest(`/repos/${REPO}/collaborators/jane.doe`) }))
      .toEqual({ kind: 'synthetic', response: 'collaborator' });
  });
  it('forwards the recursive tree listing with its query string', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/main`), search: '?recursive=1' }))
      .toEqual({ kind: 'forward', path: `/repos/${REPO}/git/trees/main?recursive=1` });
  });
  it('forwards a blob read', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/blobs/abc123`) }))
      .toEqual({ kind: 'forward', path: `/repos/${REPO}/git/blobs/abc123` });
  });
  it('forwards the rate limit probe', () => {
    expect(ask({ path: rest('/rate_limit') })).toEqual({ kind: 'forward', path: '/rate_limit' });
  });
  it('refuses those same reads under any verb but GET', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(ask({ method, path: rest(`/repos/${REPO}/git/trees/main`) }).kind).toBe('deny');
      expect(ask({ method, path: rest('/user') }).kind).toBe('deny');
    }
  });
});

describe('classifyRequest — everything else is refused', () => {
  const denied: [string, string][] = [
    ['GET', '/users/octocat'],
    ['GET', '/user/repos'],
    ['GET', '/user/repository_invitations'],
    ['GET', '/orgs/wssl2026'],
    ['GET', '/repos/someone-else/private-repo/git/trees/main'],
    ['GET', `/repos/${REPO}`],
    ['POST', `/repos/${REPO}/forks`],
    ['POST', `/repos/${REPO}/dispatches`],
    ['POST', `/repos/${REPO}/pulls`],
    ['PATCH', `/repos/${REPO}/issues/1`],
    ['POST', `/repos/${REPO}/git/refs`],
    ['PUT', `/repos/${REPO}/contents/src/data/site.json`],
    ['POST', `/repos/${REPO}/git/commits`],
    ['DELETE', `/repos/${REPO}/git/refs/heads/main`],
    ['GET', '/'],
    ['GET', '/repos'],
  ];
  it.each(denied)('refuses %s %s', (method, path) => {
    const decision = ask({ method, path: rest(path) });
    expect(decision.kind).toBe('deny');
    expect(decision).toHaveProperty('reason');
  });

  it('refuses a repo path whose owner only starts with ours', () => {
    expect(ask({ path: rest('/repos/wssl2026/wssl-cms-secrets/git/trees/main') }).kind).toBe('deny');
    expect(ask({ path: rest('/repos/wssl2026-evil/wssl-cms/git/trees/main') }).kind).toBe('deny');
  });
});

describe('classifyRequest — GraphQL', () => {
  const graphql = (body: unknown, method = 'POST') =>
    ask({ method, path: '/api/graphql', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const LAST_COMMIT = 'query($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { ref(qualifiedName: $branch) { target { ... on Commit { history(first: 1) { nodes { oid message } } } } } } }';

  const COMMIT_MUTATION =
    'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate file_0: file(path: "src/data/site.json") { oid } } } }';

  const commitInput = (overrides: Record<string, unknown> = {}) => ({
    branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
    expectedHeadOid: 'deadbeef',
    fileChanges: { additions: [{ path: 'src/data/site.json', contents: 'e30=' }], deletions: [] },
    message: { headline: 'content: update settings "site"' },
    ...overrides,
  });

  it('forwards a repository query to /graphql', () => {
    const decision = graphql({ query: LAST_COMMIT, variables: { owner: 'wssl2026', repo: 'wssl-cms', branch: 'main' } });
    expect(decision).toMatchObject({ kind: 'forward', path: '/graphql' });
  });

  it('pins the owner and repo variables to the configured repository', () => {
    const decision = graphql({ query: LAST_COMMIT, variables: { branch: 'main' } });
    expect(decision.kind).toBe('forward');
    const sent = JSON.parse((decision as { body: string }).body);
    expect(sent.variables).toMatchObject({ owner: 'wssl2026', repo: 'wssl-cms', branch: 'main' });
  });

  it('refuses a query pointed at another repository through its variables', () => {
    expect(graphql({ query: LAST_COMMIT, variables: { owner: 'someone', repo: 'wssl-cms' } }).kind).toBe('deny');
    expect(graphql({ query: LAST_COMMIT, variables: { owner: 'wssl2026', repo: 'other' } }).kind).toBe('deny');
  });

  it('refuses a query that names a repository inline instead of through the variables', () => {
    const inline = 'query { repository(owner: "someone", name: "secret") { id } }';
    expect(graphql({ query: inline }).kind).toBe('deny');
    const half = 'query($repo: String!) { repository(owner: "someone", name: $repo) { id } }';
    expect(graphql({ query: half }).kind).toBe('deny');
  });

  it('refuses a second repository smuggled in beside the allowed one', () => {
    const two =
      'query($owner: String!, $repo: String!) { a: repository(owner: $owner, name: $repo) { id } b: repository(owner: "someone", name: "secret") { id } }';
    expect(graphql({ query: two }).kind).toBe('deny');
  });

  it('refuses a query that reaches for the viewer or another owner instead of the repository', () => {
    expect(graphql({ query: 'query { viewer { login email } }' }).kind).toBe('deny');
    expect(graphql({ query: 'query { organization(login: "wssl2026") { id } }' }).kind).toBe('deny');
    expect(graphql({ query: 'query($owner: String!) { repositoryOwner(login: $owner) { id } }' }).kind).toBe('deny');
  });

  it('allows the one mutation the editor needs and refuses every other', () => {
    expect(graphql({ query: COMMIT_MUTATION, variables: { input: commitInput() } }).kind).toBe('forward');
    for (const mutation of [
      'mutation { deleteRef(input: {refId: "x"}) { clientMutationId } }',
      'mutation { createRef(input: {name: "x"}) { clientMutationId } }',
      'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }',
    ]) {
      expect(graphql({ query: mutation }).kind).toBe('deny');
    }
  });

  it('records the editor on the commit, since createCommitOnBranch has no author field', () => {
    const decision = graphql({ query: COMMIT_MUTATION, variables: { input: commitInput() } });
    const sent = JSON.parse((decision as { body: string }).body);
    expect(sent.variables.input.message.headline).toBe('content: update settings "site"');
    expect(sent.variables.input.message.body).toContain(`Co-authored-by: ${EMAIL} <${EMAIL}>`);
  });

  it('keeps a body the client already set and does not repeat the trailer', () => {
    const input = commitInput({ message: { headline: 'headline', body: 'why this changed' } });
    const decision = graphql({ query: COMMIT_MUTATION, variables: { input } });
    const body = JSON.parse((decision as { body: string }).body).variables.input.message.body as string;
    expect(body.startsWith('why this changed')).toBe(true);
    expect(body.match(/Co-authored-by:/g)).toHaveLength(1);
  });

  it('will not let a client forge the trailer for someone else', () => {
    const input = commitInput({
      message: { headline: 'h', body: 'Co-authored-by: boss@wssl.org <boss@wssl.org>' },
    });
    const decision = graphql({ query: COMMIT_MUTATION, variables: { input } });
    const body = JSON.parse((decision as { body: string }).body).variables.input.message.body as string;
    expect(body).not.toContain('boss@wssl.org');
    expect(body).toContain(`Co-authored-by: ${EMAIL} <${EMAIL}>`);
  });

  it('refuses a commit aimed at another repository', () => {
    const input = commitInput({ branch: { repositoryNameWithOwner: 'someone/else', branchName: 'main' } });
    expect(graphql({ query: COMMIT_MUTATION, variables: { input } }).kind).toBe('deny');
  });

  it('refuses a commit with no branch input at all', () => {
    expect(graphql({ query: COMMIT_MUTATION, variables: { input: { message: { headline: 'x' } } } }).kind)
      .toBe('deny');
    expect(graphql({ query: COMMIT_MUTATION, variables: {} }).kind).toBe('deny');
  });

  it('refuses GraphQL over GET, and a body that is not a query', () => {
    expect(graphql({ query: LAST_COMMIT }, 'GET').kind).toBe('deny');
    expect(graphql('not json').kind).toBe('deny');
    expect(graphql({ notAQuery: true }).kind).toBe('deny');
    expect(graphql([]).kind).toBe('deny');
    expect(ask({ method: 'POST', path: '/api/graphql' }).kind).toBe('deny');
  });
});

describe('classifyRequest — commit paths are scoped to the content roots (C1)', () => {
  const graphql = (body: unknown, method = 'POST') =>
    ask({ method, path: '/api/graphql', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const COMMIT_MUTATION =
    'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate file_0: file(path: "src/data/site.json") { oid } } } }';

  const commitInput = (overrides: Record<string, unknown> = {}) => ({
    branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
    expectedHeadOid: 'deadbeef',
    fileChanges: { additions: [{ path: 'src/data/site.json', contents: 'e30=' }], deletions: [] },
    message: { headline: 'content: update settings "site"' },
    ...overrides,
  });

  const withAddition = (path: string) =>
    graphql({
      query: COMMIT_MUTATION,
      variables: { input: commitInput({ fileChanges: { additions: [{ path, contents: 'e30=' }], deletions: [] } }) },
    });

  const withDeletion = (path: string) =>
    graphql({
      query: COMMIT_MUTATION,
      variables: { input: commitInput({ fileChanges: { additions: [], deletions: [{ path }] } }) },
    });

  it.each([
    'src/content/pages/index.md',
    'src/data/site.json',
    'public/uploads/photo.jpg',
    'public/images/logo.svg',
  ])('allows an addition under an allowed root: %s', (path) => {
    expect(withAddition(path).kind).toBe('forward');
  });

  it.each([
    'functions/api/x.ts',
    'wrangler.toml',
    '../src/content/pages/x.md',
    'src/content/pages/../../wrangler.toml',
    'src\\data\\x.json',
    '/src/data/x.json',
    'src/datalake/x.json',
    '',
  ])('refuses an addition outside the allowed roots: %j', (path) => {
    expect(withAddition(path).kind).toBe('deny');
  });

  it('refuses when the out-of-bounds path is only a deletion', () => {
    expect(withDeletion('wrangler.toml').kind).toBe('deny');
    expect(withDeletion('src/data/ok.json').kind).toBe('forward');
  });

  it('refuses a fileChanges entry with no path at all', () => {
    const input = commitInput({ fileChanges: { additions: [{ contents: 'e30=' }], deletions: [] } });
    expect(graphql({ query: COMMIT_MUTATION, variables: { input } }).kind).toBe('deny');
  });
});

describe('classifyRequest — a commit may only land on the production branch (I2)', () => {
  const graphql = (body: unknown, method = 'POST') =>
    ask({ method, path: '/api/graphql', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const COMMIT_MUTATION =
    'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate } } }';

  const commitInput = (overrides: Record<string, unknown> = {}) => ({
    branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
    expectedHeadOid: 'deadbeef',
    fileChanges: { additions: [], deletions: [] },
    message: { headline: 'content: update settings "site"' },
    ...overrides,
  });

  it('allows a commit aimed at the configured production branch', () => {
    expect(graphql({ query: COMMIT_MUTATION, variables: { input: commitInput() } }).kind).toBe('forward');
  });

  it('refuses a commit aimed at any other branch', () => {
    const input = commitInput({ branch: { repositoryNameWithOwner: REPO, branchName: 'feature-x' } });
    expect(graphql({ query: COMMIT_MUTATION, variables: { input } }).kind).toBe('deny');
  });
});

describe('classifyRequest — the tree read is pinned to the branch or a commit SHA (I2, M4)', () => {
  const SHA = 'a'.repeat(40);

  it('allows the configured production branch', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/main`) }).kind).toBe('forward');
  });

  it('allows a full 40-hex commit SHA', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/${SHA}`) }).kind).toBe('forward');
  });

  it('refuses any other branch name', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/feature-x`) }).kind).toBe('deny');
  });

  it('refuses a ref that only looks like a SHA (wrong length)', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/${SHA.slice(0, 7)}`) }).kind).toBe('deny');
  });

  it('refuses a percent-encoded traversal attempt riding along in the ref (M4)', () => {
    expect(ask({ path: rest(`/repos/${REPO}/git/trees/main%2F..%2F..%2Fuser`) }).kind).toBe('deny');
  });
});

describe('classifyRequest — GraphQL file reads are scoped (I3)', () => {
  const graphql = (body: unknown, method = 'POST') =>
    ask({ method, path: '/api/graphql', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const readQuery = (expression: string) =>
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { file_0: object(expression: ${JSON.stringify(expression)}) { ... on Blob { oid text } } } }`;

  it('allows a read of an allowed path on the production branch', () => {
    expect(graphql({ query: readQuery('main:src/data/site.json') }).kind).toBe('forward');
  });

  it('allows a read pinned to a commit SHA', () => {
    const sha = 'b'.repeat(40);
    expect(graphql({ query: readQuery(`${sha}:src/content/pages/index.md`) }).kind).toBe('forward');
  });

  it('refuses a read of a path outside the content roots', () => {
    expect(graphql({ query: readQuery('main:wrangler.toml') }).kind).toBe('deny');
  });

  it('refuses a read pinned to a branch other than production', () => {
    expect(graphql({ query: readQuery('feature-x:src/data/site.json') }).kind).toBe('deny');
  });

  it('refuses an expression with no path after the ref', () => {
    expect(graphql({ query: readQuery('main') }).kind).toBe('deny');
  });
});

describe('classifyRequest — a commit trailer cannot be smuggled through the headline (M5)', () => {
  const graphql = (body: unknown, method = 'POST') =>
    ask({ method, path: '/api/graphql', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const COMMIT_MUTATION =
    'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate } } }';

  const commitInput = (overrides: Record<string, unknown> = {}) => ({
    branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
    expectedHeadOid: 'deadbeef',
    fileChanges: { additions: [], deletions: [] },
    message: { headline: 'content: update settings "site"' },
    ...overrides,
  });

  it('strips a newline-smuggled trailer out of the headline entirely', () => {
    const input = commitInput({
      message: { headline: 'Real headline\nCo-authored-by: boss@wssl.org <boss@wssl.org>' },
    });
    const decision = graphql({ query: COMMIT_MUTATION, variables: { input } });
    const sent = JSON.parse((decision as { body: string }).body);
    expect(sent.variables.input.message.headline).not.toContain('\n');
    expect(sent.variables.input.message.headline).not.toContain('boss@wssl.org');
    expect(sent.variables.input.message.headline).toBe('Real headline');
    expect(sent.variables.input.message.body).toContain(`Co-authored-by: ${EMAIL} <${EMAIL}>`);
    expect(sent.variables.input.message.body.match(/Co-authored-by:/g)).toHaveLength(1);
  });

  it('leaves an ordinary single-line headline untouched', () => {
    const decision = graphql({ query: COMMIT_MUTATION, variables: { input: commitInput() } });
    const sent = JSON.parse((decision as { body: string }).body);
    expect(sent.variables.input.message.headline).toBe('content: update settings "site"');
  });
});

describe('repoRelativePath', () => {
  it('keeps the repository out of the log line', () => {
    expect(repoRelativePath(`/repos/${REPO}/git/trees/main?recursive=1`, REPO)).toBe('/git/trees/main?recursive=1');
    expect(repoRelativePath('/graphql', REPO)).toBe('/graphql');
    expect(repoRelativePath('/user', REPO)).toBe('/user');
  });
});

describe('the upstream origin', () => {
  it('is GitHub and nothing else', () => {
    expect(GITHUB_API_ORIGIN).toBe('https://api.github.com');
  });
});
