/** HTML page that completes Decap CMS's popup OAuth handshake. */
export function callbackHtml(provider: string, payload: { token: string; provider: string }): string {
  const message = `authorization:${provider}:success:${JSON.stringify(payload)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><p>Signing you in…</p>
<script>
(function () {
  function receiveMessage(e) {
    if (e.source !== window.opener) return;
    window.opener.postMessage(${JSON.stringify(message)}, e.origin);
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  window.opener.postMessage('authorizing:${provider}', '*');
})();
</script>
</body></html>`;
}
