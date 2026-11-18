// Electron shell for the full Windows build (built in CI via electron-builder).
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');
function create() {
  const win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 800, minHeight: 600, backgroundColor: '#0e0f13',
    title: 'ClipForge', icon: path.join(__dirname, '..', 'www', 'icons', 'icon-256.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(() => {
  session.defaultSession.on('will-download', item => item.setSaveDialogOptions({ title: 'Zapisz wideo' }));
  create();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) create(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
