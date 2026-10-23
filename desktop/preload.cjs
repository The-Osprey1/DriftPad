const { contextBridge, ipcRenderer } = require('electron');

// No paths, bytes, shell commands, or generic IPC methods cross this bridge.
contextBridge.exposeInMainWorld('driftpadDesktop', Object.freeze({
  installFirmware: () => ipcRenderer.invoke('driftpad:install-firmware'),
}));
