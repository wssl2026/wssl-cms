/**
 * `GET /api/cms/auth` — the sign-in popup Sveltia CMS opens.
 *
 * Sveltia is built to get its API credential from an OAuth popup, and it speaks the
 * Netlify/Decap handshake to do it (`services/backends/git/shared/auth.js`): the popup
 * posts `authorizing:github` to its opener, the opener echoes it back, and the popup then
 * posts `authorization:github:success:{"provider":"github","token":"…"}`.
 *
 * There is no OAuth here. Cloudflare Access has already established who the editor is
 * before this function runs, so this route reads the Access JWT, mints a short-lived
 * session token for that email (see `_lib/cms-session.ts`), and hands *that* back through
 * the same handshake. The GitHub bot token never leaves the server: `/api/cms/gh/*` swaps
 * the session token for it, and only for an editor whose Access JWT still agrees.
 */
import { mintSession } from '../../_lib/cms-session';
import { defaultVerifyJwt, jsonError, resolveEditor } from '../../_lib/cms-access';
import type { CmsEnv, VerifyJwt } from '../../_lib/cms-access';

export interface CmsAuthDeps {
  verifyJwt: VerifyJwt;
}

export function createCmsAuthHandler(overrides: Partial<CmsAuthDeps> = {}): PagesFunction<CmsEnv> {
  const verifyJwt = overrides.verifyJwt ?? defaultVerifyJwt;

  return async ({ request, env }) => {
    if (!env.CMS_SESSION_SECRET) {
      return jsonError('The site editor is not configured: CMS_SESSION_SECRET is not set.', 503);
    }

    const editor = await resolveEditor(request, env, verifyJwt);
    if (editor instanceof Response) return editor;

    const token = await mintSession(editor.email, env.CMS_SESSION_SECRET);

    return new Response(handshakePage(token), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // This page hands out a credential over postMessage; it has no business in a frame.
        'X-Frame-Options': 'DENY',
      },
    });
  };
}

/**
 * The popup body. The token is embedded as a JSON string literal — it is base64url and a
 * dot by construction, and `JSON.stringify` plus the `<`/`&` escapes below mean even a
 * token that somehow was not could not close the script element.
 */
function handshakePage(token: string): string {
  const literal = JSON.stringify(token).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex" />
<title>Signing in…</title>
</head>
<body>
<p>Signing you in… you can close this window if it does not close itself.</p>
<script>
(function () {
  var provider = 'github';
  var token = ${literal};

  // Opened as a popup by /admin, or it is nobody's business. Without an opener there is
  // no one to hand the session to, and this page must not simply display it.
  if (!window.opener) {
    document.body.textContent = 'Open the editor at /admin/ and sign in from there.';
    return;
  }

  function onMessage(event) {
    // /admin and this page are the same origin; a message from anywhere else is not the
    // editor asking, so it gets no token.
    if (event.origin !== window.location.origin) return;
    if (event.data !== 'authorizing:' + provider) return;
    window.removeEventListener('message', onMessage);
    window.opener.postMessage(
      'authorization:' + provider + ':success:' + JSON.stringify({ provider: provider, token: token }),
      window.location.origin
    );
  }

  window.addEventListener('message', onMessage);
  window.opener.postMessage('authorizing:' + provider, window.location.origin);
})();
</script>
</body>
</html>
`;
}

export const onRequestGet = createCmsAuthHandler();
