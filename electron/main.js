const { app, BrowserWindow } = require('electron');
const { ipcMain } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const nspell = require('nspell');
const dictionary = require('dictionary-en-us');

const pending = [];

let helperProc;
let helperReader;
let win;
let spellPromise;
let allowList = new Set();
const allowPath = path.join(__dirname, 'spellcheck_allowlist.txt');
fs.promises
  .readFile(allowPath, 'utf8')
  .then(contents => {
    allowList = new Set(
      contents
        .split(/\r?\n/)
        .map(w => w.trim().toLowerCase())
        .filter(Boolean)
    );
  })
  .catch(() => {
    allowList = new Set();
  });

function loadSpell() {
  if (!spellPromise) {
    spellPromise = new Promise((resolve, reject) => {
      dictionary((err, dict) => {
        if (err) {
          reject(err);
        } else {
          resolve(nspell(dict));
        }
      });
    });
  }
  return spellPromise;
}

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  helperProc = spawn('python', ['-m', 'helper.resolve_helper'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: path.join(__dirname, '..')
  });
  helperReader = readline.createInterface({ input: helperProc.stdout });

  helperReader.on('line', line => {
    try {
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

      if (message.event === 'message') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('helper-message', message.message || message.data)
        );
        return;
      }

      if (pending.length) {
        const event = pending.shift();
        message = Object.assign({ ok: !message.error }, message);
        event.reply('helper-response', message);
      }
    } catch (err) {
      console.error('Error processing helper output:', err);
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-error', { error: err.message })
      );
    }
  });

  ipcMain.on('helper-request', (event, payload) => {
    if (!helperProc) {
      event.reply('helper-response', { ok: false, error: 'helper not running' });
      return;
    }
    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    helperProc.stdin.write(`${request}\n`);
    pending.push(event);
  });

  ipcMain.handle('fs:readFile', (_, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:writeFile', (_, p, data) =>
    fs.promises.writeFile(p, data, 'utf8')
  );
  ipcMain.handle('fs:stat', (_, p) => fs.promises.stat(p));

  ipcMain.handle('spellcheck:misspellings', async (_, text) => {
    try {
      const spell = await loadSpell();
      const words = String(text)
        .split(/\W+/)
        .filter(Boolean);
      const misspelled = [];
      let ignored = 0;
      for (const w of words) {
        if (!spell.correct(w)) {
          if (allowList.has(w.toLowerCase())) {
            ignored++;
          } else {
            misspelled.push(w);
          }
        }
      }
      return { words: words.length, misspelled, ignored };
    } catch (err) {
      return { words: 0, misspelled: [], ignored: 0 };
    }
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
  if (helperProc) {
    helperProc.kill();
    helperProc = null;
    helperReader && helperReader.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
