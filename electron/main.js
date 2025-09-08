const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

let helper;
let helperReader;
const pending = [];

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  helper = spawn('python', [path.join(__dirname, '..', 'helper', 'resolve_helper.py')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  helperReader = readline.createInterface({ input: helper.stdout });

  helperReader.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      message = { ok: false, error: 'invalid response' };
    }

    if (message.event === 'status') {
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-status', message)
      );
      return;
    }

    if (pending.length) {
      const event = pending.shift();
      message = Object.assign({ ok: !message.error }, message);
      event.reply('helper-response', message);
    } else {
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-status', message)
      );
    }
  });

  ipcMain.on('helper-request', (event, payload) => {
    if (!helper) {
      event.reply('helper-response', { ok: false, error: 'helper not running' });
      return;
    }
    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    helper.stdin.write(`${request}\n`);
    pending.push(event);
  });

  // Handle generic leaderpass actions invoked from the renderer.
  ipcMain.handle('leaderpass-call', async (event, action) => {
    const msg = `Action ${action} invoked`;
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('helper-message', msg)
    );
    return { status: 'ok' };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (helper) {
    helper.kill();
    helper = null;
    helperReader && helperReader.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
