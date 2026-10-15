// Never silently select the first serial device on the user's computer.
async function selectSerialPort({ ports, session, showDialog, isAlive }) {
  if (!ports.length) {
    await showDialog({
      type: 'info', title: 'Connect your DriftPad',
      message: 'No serial devices found',
      detail: 'Plug in your DriftPad with a USB data cable, then try Connect USB again. If the Pico appears as RPI-RP2, install its firmware first.',
      buttons: ['OK'],
    });
    return '';
  }
  const available = new Set(ports.map((port) => port.portId));
  const removed = (_event, port) => available.delete(port.portId);
  session.on('serial-port-removed', removed);
  try {
    const result = await showDialog({
      type: 'question', title: 'Connect DriftPad',
      message: 'Choose your DriftPad',
      detail: 'Select your pad. If you just plugged it in, cancel and try Connect USB again.',
      buttons: ['Cancel', ...ports.map((port) =>
        (port.displayName || 'Serial device') + ' (' + port.portName + ')')],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    const selected = ports[result.response - 1];
    return isAlive() && selected && available.has(selected.portId) ? selected.portId : '';
  } finally {
    session.removeListener('serial-port-removed', removed);
  }
}
module.exports = { selectSerialPort };
