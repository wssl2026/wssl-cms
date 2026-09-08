interface Env { GITHUB_OAUTH_CLIENT_ID: string; GITHUB_OAUTH_CLIENT_SECRET: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const origin = new URL(request.url).origin;
  const state = crypto.randomUUID();
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  target.searchParams.set('redirect_uri', `${origin}/api/callback`);
  target.searchParams.set('scope', 'repo,user');
  target.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Set-Cookie': `decap_oauth_state=${state}; Path=/api/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
};
