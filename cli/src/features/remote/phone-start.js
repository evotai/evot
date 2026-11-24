// Built into the document as a single script. Import errors (including a
// browser security exception at module initialization) must not leave a live-looking button.
const status = document.getElementById('deviceStatus');
function unavailable(message) {
  status.textContent = message;
  const button = document.querySelector('#pair button');
  button.disabled = false;
  button.textContent = 'Reload page';
  button.type = 'button';
  button.onclick = () => location.reload();
}
if (!window.isSecureContext || !window.crypto?.subtle) {
  unavailable('Secure pairing is unavailable. Open the HTTPS invite in Safari or Chrome.');
} else {
  import('./phone-client.js').catch(error => {
    unavailable(error.name === 'SecurityError' || error.name === 'QuotaExceededError'
      ? 'Browser storage is blocked. Open the invite in Safari or Chrome with site data enabled.'
      : 'The connection page could not start. Reload it, or reopen the invite in Safari or Chrome.');
  });
}
