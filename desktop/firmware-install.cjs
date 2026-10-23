const fs = require('node:fs/promises');
const path = require('node:path');

// The bundled Pico image uses 256-byte flash payloads, with an RP2040 family ID.
// Reject unsupported UF2 variants rather than treating any file with UF2 magic as firmware.
function validateUf2(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 512 || bytes.length > 4 * 1024 * 1024) {
    throw new Error('The bundled firmware is incomplete. Download a fresh copy of DriftPad.');
  }
  const blocks = bytes.length / 512;
  const addresses = new Set();
  const numbers = new Set();
  for (let offset = 0; offset < bytes.length; offset += 512) {
    const flags = bytes.readUInt32LE(offset + 8);
    const address = bytes.readUInt32LE(offset + 12);
    const payload = bytes.readUInt32LE(offset + 16);
    const number = bytes.readUInt32LE(offset + 20);
    if (bytes.readUInt32LE(offset) !== 0x0a324655 ||
        bytes.readUInt32LE(offset + 4) !== 0x9e5d5157 ||
        bytes.readUInt32LE(offset + 508) !== 0x0ab16f30 ||
        flags !== 0x2000 || bytes.readUInt32LE(offset + 28) !== 0xe48bff56 ||
        payload !== 256 || address < 0x10000000 || address + payload > 0x10200000 ||
        address % 256 !== 0 || numbers.has(number) || number >= blocks ||
        bytes.readUInt32LE(offset + 24) !== blocks || addresses.has(address)) {
      throw new Error('The bundled firmware is not a complete RP2040 Pico image. Download a fresh copy of DriftPad.');
    }
    numbers.add(number);
    addresses.add(address);
  }
  if (!addresses.has(0x10000000)) throw new Error('The bundled firmware is missing its boot block.');
  return { blocks, bytes: bytes.length };
}

function isBootDriveInfo(text) {
  return typeof text === 'string' && text.length <= 4096 &&
    /^UF2 Bootloader\b/m.test(text) && /^Board-ID:\s*RPI-RP2\s*$/m.test(text);
}

function windowsDriveRoot(directory) {
  // A folder picker must select a drive-letter root, never a subfolder, UNC path,
  // device path, relative path, or renderer-supplied output filename.
  if (typeof directory !== 'string' || !/^[A-Za-z]:[\\/]$/.test(directory)) {
    throw new Error('Choose the RPI-RP2 drive itself under This PC, not a folder inside it.');
  }
  return path.win32.normalize(directory);
}

async function copyFirmwareToDrive(directory, firmware, io = fs) {
  validateUf2(firmware);
  const root = windowsDriveRoot(directory);
  const info = await io.readFile(path.win32.join(root, 'INFO_UF2.TXT'), 'utf8');
  if (!isBootDriveInfo(info)) {
    throw new Error('That drive is not an RP2040 in BOOTSEL mode. Hold BOOTSEL while plugging in the Pico, then choose RPI-RP2.');
  }
  // Exclusive creation prevents overwriting an existing file on the chosen drive.
  // Flush the write before reporting completion; a disconnect/error is never success.
  await io.writeFile(path.win32.join(root, 'DriftPad.uf2'), firmware, { flag: 'wx', flush: true });
  return { status: 'copied' };
}

function createFirmwareInstaller({ readFirmware, chooseDrive, isAllowed, onBusyChange = () => {}, io = fs }) {
  let busy = false;
  return async (event) => {
    if (!isAllowed(event)) return { status: 'error', message: 'Firmware setup is only available in the DriftPad window.' };
    if (busy) return { status: 'error', message: 'Firmware setup is already open.' };
    busy = true;
    onBusyChange(true);
    try {
      const firmware = await readFirmware();
      validateUf2(firmware);
      const selection = await chooseDrive();
      if (selection.canceled || !selection.filePaths?.length) return { status: 'cancelled' };
      if (!isAllowed(event)) return { status: 'cancelled' };
      return await copyFirmwareToDrive(selection.filePaths[0], firmware, io);
    } catch (error) {
      const messages = {
        ENOENT: 'The Pico drive or bundled firmware could not be found. Hold BOOTSEL while plugging in the Pico, then try again.',
        EACCES: 'Windows denied access. Close other programs using the Pico drive, then try again.',
        EPERM: 'Windows denied access. Close other programs using the Pico drive, then try again.',
        EEXIST: 'A DriftPad.uf2 file already exists there. Reconnect the Pico in BOOTSEL mode and choose its RPI-RP2 drive.',
        EIO: 'The copy could not be confirmed. Check the cable and reconnect in BOOTSEL mode before retrying.',
      };
      return { status: 'error', message: messages[error.code] || error.message || 'The copy could not be confirmed. Reconnect in BOOTSEL mode and try again.' };
    } finally { busy = false; onBusyChange(false); }
  };
}

module.exports = { validateUf2, isBootDriveInfo, windowsDriveRoot, copyFirmwareToDrive, createFirmwareInstaller };
