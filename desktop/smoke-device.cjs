// Runs only on the bundled ?simulate=1 page. Never opens a real serial port.
module.exports = async function smokeDevice() {
  const waitFor = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Device interface did not reach its expected state');
  };
  await waitFor(() => window.DriftPadApp);
  if (new URLSearchParams(location.search).get('simulate') !== '1') throw new Error('Simulation required');
  document.querySelector('#connectBtn').click();
  const session = window.DriftPadApp.session;
  await waitFor(() => session.isConnected);
  const identified = session.info.device === 'DriftPad' && session.info.protocol === 2;
  const safeStartup = session.deviceStatus.output?.enabled === false;
  await session.setSetting('actuation', 1.75);
  const confirmed = session.confirmed.actuation === 1.75 && session.dirty === true;
  await session.save();
  const saved = session.dirty === false;
  if (!identified || !safeStartup || !confirmed || !saved) throw new Error('Device handshake or confirmed settings failed');
  return { identified, safeStartup, confirmed, saved, simulated: true };
};
