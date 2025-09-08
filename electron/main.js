const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

let helper;
let helperReader;

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

  ipcMain.on('helper-request', (event, payload) => {
    if (!helper) {
      event.reply('helper-response', { error: 'helper not running' });
      return;
    }
    helper.stdin.write(`${JSON.stringify(payload)}\n`);
    helperReader.once('line', line => {
      let response;
      try {
        response = JSON.parse(line);
      } catch (e) {
        response = { error: 'invalid response' };
      }
      event.reply('helper-response', response);
    });
  });

  // Handle generic leaderpass actions invoked from the renderer.
  ipcMain.handle('leaderpass-call', async (event, action) => {
    if (action === 'context') {
      // In a real application this would retrieve live context.
      return { status: 'ok', message: 'connected' };
    }
    const msg = `Action ${action} invoked`;
    // Forward message to renderer consoles.
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
