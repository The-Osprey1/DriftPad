const { app, BrowserWindow, Menu, dialog, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { APP_URL, isAppUrl, resolveAsset, isProjectLink } = require('./security.cjs');
const { selectSerialPort } = require('./serial-picker.cjs');

const smoke = process.argv.includes('--smoke-test');
app.setName('DriftPad');
app.setAppUserModelId('io.github.theosprey1.driftpad');
app.setPath('userData', smoke && process.env.DRIFTPAD_SMOKE_DATA
  ? process.env.DRIFTPAD_SMOKE_DATA : path.join(app.getPath('appData'), 'DriftPad'));
protocol.registerSchemesAsPrivileged([{
  scheme: 'driftpad',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

let mainWindow;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
async function openProjectLink(url) {
  if (isProjectLink(url)) await shell.openExternal(url);
}
async function setupSession() {
  const ses = session.defaultSession;
  const root = path.join(__dirname, 'renderer');
  ses.protocol.handle('driftpad', async (request) => {
    const file = resolveAsset(root, request.url);
    if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
    try {
      const result = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(result.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(result.body, { status: result.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const trusted = (contents) => !!contents && contents === mainWindow?.webContents &&
    !contents.isDestroyed() && isAppUrl(contents.getURL());
  ses.setPermissionCheckHandler((contents, permission, origin) =>
    permission === 'serial' && trusted(contents) && isAppUrl(origin));
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permission === 'serial' && trusted(contents) && isAppUrl(details.requestingUrl)));
  // The default device handler remembers only explicitly chosen devices for this window.
  ses.on('select-serial-port', async (event, ports, contents, callback) => {
    event.preventDefault();
    if (!trusted(contents)) { callback(''); return; }
    try {
      callback(await selectSerialPort({
        ports, session: ses, isAlive: () => trusted(contents),
        showDialog: (options) => dialog.showMessageBox(mainWindow, options),
      }));
    } catch { callback(''); }
  });
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      title: 'Save DriftPad file', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
    });
  });
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'DriftPad', width: 1440, height: 940, minWidth: 960, minHeight: 680,
    backgroundColor: '#f5f2eb', show: false, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const win = mainWindow;
  win.once('ready-to-show', () => { if (!smoke) win.show(); });
  win.on('closed', () => { mainWindow = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openProjectLink(url).catch(console.error);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    void openProjectLink(url).catch(console.error);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', () => {
    if (!smoke) dialog.showErrorBox('DriftPad stopped responding', 'Close and reopen DriftPad. Your saved profiles are kept on this PC.');
  });
  await win.loadURL(APP_URL);
  if (smoke) {
    try {
      const result = await win.webContents.executeJavaScript(
        "(async () => { for(let i=0;i<100 && !document.querySelector('#root')?.textContent.includes('Digital Twin');i++) await new Promise(r=>setTimeout(r,50)); const previous=localStorage.getItem('desktop-smoke'); localStorage.setItem('desktop-smoke','saved'); const firmware=await fetch('./driftpad.uf2'); const bytes=new Uint8Array(await firmware.arrayBuffer()); return { rendered:document.querySelector('#root').textContent.includes('Digital Twin'), serial:'serial' in navigator, secure:window.isSecureContext, node:typeof window.require, previous, firmware:firmware.ok && bytes[0]===0x55 && bytes[1]===0x46 && bytes[2]===0x32 }; })()"
      );
      if (!result.rendered || !result.serial || !result.secure || result.node !== 'undefined' || !result.firmware) {
        throw new Error(JSON.stringify(result));
      }
      session.defaultSession.flushStorageData();
      if (process.env.DRIFTPAD_SMOKE_RESULT) {
        await fs.writeFile(process.env.DRIFTPAD_SMOKE_RESULT, JSON.stringify(result));
        await fs.writeFile(process.env.DRIFTPAD_SMOKE_RESULT + '.png', (await win.capturePage()).toPNG());
      }
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  }
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: 'Help', submenu: [
        { label: 'Downloads and updates', click: () => { void openProjectLink('https://github.com/The-Osprey1/DriftPad/releases').catch(console.error); } },
        { label: 'About DriftPad', click: () => dialog.showMessageBox(mainWindow, { title: 'DriftPad', message: 'DriftPad ' + app.getVersion(), detail: 'Macropad configurator and Digital Twin. Profiles are saved on this PC.' }) },
      ] },
    ]));
    await setupSession();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(console.error);
    });
  }).catch((error) => {
    if (!smoke) dialog.showErrorBox('Unable to open DriftPad', String(error));
    console.error(error);
    app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
