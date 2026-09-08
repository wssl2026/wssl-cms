import { callbackHtml } from '../_lib/oauth';

interface Env { GITHUB_OAUTH_CLIENT_ID: string; GITHUB_OAUTH_CLIENT_SECRET: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = (request.headers.get('Cookie') ?? '').match(/decap_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response('Invalid OAuth state. Close this window and try signing in again.', { status: 400 });
  }
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/callback`,
    }),
  });
  const data = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    return new Response(`GitHub sign-in failed: ${data.error ?? 'no token returned'}`, { status: 400 });
  }
  return new Response(callbackHtml('github', { token: data.access_token, provider: 'github' }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'decap_oauth_state=; Path=/api/callback; Max-Age=0',
    },
  });
};
