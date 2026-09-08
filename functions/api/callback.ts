import { callbackHtml } from '../_lib/oauth';

interface Env { GITHUB_OAUTH_CLIENT_ID: string; GITHUB_OAUTH_CLIENT_SECRET: string }

const CLEAR_STATE_COOKIE = 'decap_oauth_state=; Path=/api/callback; Max-Age=0';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = (request.headers.get('Cookie') ?? '').match(/decap_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response('Invalid OAuth state. Close this window and try signing in again.', {
      status: 400,
      headers: { 'Set-Cookie': CLEAR_STATE_COOKIE },
    });
  }
  let data: { access_token?: string; error?: string };
  try {
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
    data = (await tokenRes.json()) as { access_token?: string; error?: string };
  } catch {
    return new Response('GitHub sign-in failed: could not reach GitHub. Close this window and try again.', {
      status: 502,
      headers: { 'Set-Cookie': CLEAR_STATE_COOKIE },
    });
  }
  if (!data.access_token) {
    return new Response(`GitHub sign-in failed: ${data.error ?? 'no token returned'}`, {
      status: 400,
      headers: { 'Set-Cookie': CLEAR_STATE_COOKIE },
    });
  }
  return new Response(callbackHtml('github', { token: data.access_token, provider: 'github' }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': CLEAR_STATE_COOKIE,
    },
  });
};
