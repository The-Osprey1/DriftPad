// Executed in the isolated renderer by --smoke-test. The native install handler
// rejects smoke-test requests before opening a dialog or touching a drive.
module.exports = async function smokeRenderer() {
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the app');
  };
  await waitFor(() => document.querySelector('#root')?.textContent.includes('Digital Twin'));
  const previous = localStorage.getItem('desktop-smoke');
  localStorage.setItem('desktop-smoke', 'saved');
  const firmware = await fetch('./driftpad.uf2');
  const bytes = new Uint8Array(await firmware.arrayBuffer());
  const bridge = window.driftpadDesktop;
  const bridgeLimited = !!bridge && Object.keys(bridge).join(',') === 'installFirmware' && typeof bridge.installFirmware === 'function';
  const rejected = bridgeLimited ? await bridge.installFirmware() : null;
  const nativeWritesDisabled = rejected?.status === 'error';
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('Set Up Pad'));
  button?.click();
  await waitFor(() => document.querySelector('dialog[open] a[download="DriftPad.uf2"]'));
  const dialog = document.querySelector('dialog[open]');
  const setup = dialog.textContent.includes('Choose drive & install') &&
    dialog.textContent.includes('BOOTSEL') && dialog.contains(document.activeElement);
  const installButton = [...dialog.querySelectorAll('button')].find((node) => node.textContent.includes('Choose drive & install'));
  installButton.click();
  await waitFor(() => dialog.querySelector('[role="alert"]') && !installButton.disabled);
  const setupError = dialog.querySelector('[role="alert"]').textContent.includes('only available');
  dialog.querySelector('[aria-label="Close firmware setup"]').click();
  await waitFor(() => !document.querySelector('dialog[open]'));
  button.click();
  await waitFor(() => document.querySelector('dialog[open] a[download="DriftPad.uf2"]'));
  // Let the compositor paint the final ready state before capturePage.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return {
    rendered: true, serial: 'serial' in navigator, secure: window.isSecureContext,
    node: typeof window.require, previous, firmware: firmware.ok && bytes[0] === 0x55 && bytes[1] === 0x46 && bytes[2] === 0x32,
    bridgeLimited, nativeWritesDisabled, setup, setupError,
    dialogFits: document.querySelector('dialog[open]').getBoundingClientRect().bottom <= window.innerHeight &&
      document.querySelector('dialog[open]').getBoundingClientRect().top >= 0,
  };
};
