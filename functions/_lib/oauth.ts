/** HTML page that completes Decap CMS's popup OAuth handshake. */
export function callbackHtml(provider: string, payload: { token: string; provider: string }): string {
  const message = `authorization:${provider}:success:${JSON.stringify(payload)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><p id="status">Signing you in…</p>
<script>
(function () {
  var MSG = ${JSON.stringify(message)};
  if (!window.opener) {
    document.getElementById('status').textContent = 'Close this window and start sign-in again from the editor.';
    return;
  }
  function receiveMessage(e) {
    // The sender must be the popup's opener AND live on this origin: proving
    // only that it is the opener would hand the token to any site that opened us.
    if (e.source !== window.opener || e.origin !== window.location.origin) return;
    window.opener.postMessage(MSG, window.location.origin);
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  window.opener.postMessage('authorizing:${provider}', '*');
})();
</script>
</body></html>`;
}
