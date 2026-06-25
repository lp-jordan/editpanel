const fs = require('fs');
const path = require('path');
const nspell = require('nspell');

let dictionary;

// Resolve the writable allowlist path lazily. The bundled copy in __dirname is
// read-only once the app is packaged into an asar, so the editable allowlist
// lives in Electron's per-machine userData dir. `require('electron')` returns a
// path string (not the module) outside an Electron runtime — wrapping in
// try/catch keeps spellcheck.js usable from plain-node test harnesses, falling
// back to the bundled file.
let electronApp;
try {
  electronApp = require('electron').app;
} catch (_) {
  electronApp = null;
}

// The bundled allowlist (if any) seeds the userData copy on first run, so an
// existing word list shipped with the app isn't lost on upgrade.
const seedAllowPath = path.join(__dirname, 'spellcheck_allowlist.txt');

function getAllowPath() {
  if (electronApp && typeof electronApp.getPath === 'function') {
    try {
      return path.join(electronApp.getPath('userData'), 'spellcheck_allowlist.txt');
    } catch (_) {
      /* getPath can throw before app init — fall through to the bundled path */
    }
  }
  return seedAllowPath;
}

async function loadDictionary() {
  if (dictionary === undefined) {
    try {
      const mod = await import('dictionary-en');
      dictionary = mod.default || mod;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn(
          "dictionary-en module not found; spell checking will treat all words as valid. Install 'dictionary-en' for full spell checking."
        );
        dictionary = null;
      } else {
        throw err;
      }
    }
  }
  return dictionary;
}

let spellPromise;
let allowList = new Set();
let allowListPromise;

function parseAllowList(contents) {
  return String(contents)
    .split(/\r?\n/)
    .map(w => w.trim().toLowerCase())
    .filter(Boolean);
}

// Normalise a candidate word to its allowlist key: lower-cased, curly→straight
// apostrophe (Resolve auto-corrects to U+2019), trimmed. Returns '' if the
// token contains no letters (numbers / punctuation aren't dictionary words).
function normalizeWord(word) {
  const w = String(word == null ? '' : word).replace(/’/g, "'").trim().toLowerCase();
  return /[a-z]/.test(w) ? w : '';
}

// Load the allowlist once, lazily. Reads the userData copy; if absent, seeds
// from the bundled file (if present). Idempotent — every entry point awaits it.
function ensureAllowListLoaded() {
  if (!allowListPromise) {
    const userPath = getAllowPath();
    allowListPromise = fs.promises
      .readFile(userPath, 'utf8')
      .then(parseAllowList)
      .catch(() => {
        // No userData copy yet — try the bundled seed (skip if it IS the seed).
        if (userPath === seedAllowPath) return [];
        return fs.promises.readFile(seedAllowPath, 'utf8').then(parseAllowList).catch(() => []);
      })
      .then(words => {
        allowList = new Set(words);
        return allowList;
      });
  }
  return allowListPromise;
}

// Persist the current allowlist to the writable path, sorted for stable diffs.
async function persistAllowList() {
  const sorted = Array.from(allowList).sort();
  const body = sorted.length ? sorted.join('\n') + '\n' : '';
  await fs.promises.writeFile(getAllowPath(), body, 'utf8');
}

function loadSpell() {
  if (!spellPromise) {
    spellPromise = loadDictionary().then(dict => {
      if (dict) {
        if (typeof dict === 'function') {
          return new Promise((resolve, reject) => {
            dict((err, data) => {
              if (err) {
                reject(err);
              } else {
                resolve(nspell(data));
              }
            });
          });
        }

        const spell = nspell(dict);
        return typeof spell.correct === 'function' && typeof spell.suggest === 'function'
          ? spell
          : { correct: () => true, suggest: () => [] };
      }
      return { correct: () => true, suggest: () => [] };
    });
  }
  return spellPromise;
}

// Tokenize so contractions and possessives stay intact (`isn't`, `John's`),
// straight or curly apostrophe — Resolve auto-corrects to U+2019 — both count.
// Pure-numeric tokens (`13`, `2025`) are excluded entirely: hunspell dicts
// don't include numbers, so nspell would flag every digit run as misspelled.
function tokenizeForSpellcheck(text) {
  const normalized = String(text).replace(/’/g, "'");
  const matches = normalized.match(/[A-Za-z](?:['A-Za-z]*[A-Za-z])?/g) || [];
  return matches;
}

async function misspellings(_, text) {
  const words = tokenizeForSpellcheck(text);
  try {
    const [spell] = await Promise.all([loadSpell(), ensureAllowListLoaded()]);
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
    console.error('Spellcheck failed to load dictionary', err);
    return {
      words: words.length,
      misspelled: [],
      ignored: 0,
      error: err && err.message ? err.message : String(err)
    };
  }
}

async function suggestions(_, word) {
  try {
    const spell = await loadSpell();
    const results =
      typeof spell.suggest === 'function' ? spell.suggest(String(word)) : [];
    return results.slice(0, 5);
  } catch (err) {
    console.error('Spell suggestion failed to load dictionary', err);
    return [];
  }
}

// --- Allowlist (custom dictionary) management ---------------------------
// IPC-shaped signatures: handlers are invoked as (event, ...args), so the
// first parameter is the Electron event and is ignored.

async function listAllowlist() {
  try {
    await ensureAllowListLoaded();
    return { ok: true, words: Array.from(allowList).sort() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), words: [] };
  }
}

async function addAllowWord(_, word) {
  const w = normalizeWord(word);
  if (!w) return { ok: false, error: 'Enter a word containing at least one letter.' };
  try {
    await ensureAllowListLoaded();
    if (!allowList.has(w)) {
      allowList.add(w);
      await persistAllowList();
    }
    return { ok: true, added: w, words: Array.from(allowList).sort() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function removeAllowWord(_, word) {
  const w = normalizeWord(word);
  if (!w) return { ok: false, error: 'No word given.' };
  try {
    await ensureAllowListLoaded();
    if (allowList.delete(w)) {
      await persistAllowList();
    }
    return { ok: true, removed: w, words: Array.from(allowList).sort() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  misspellings,
  suggestions,
  listAllowlist,
  addAllowWord,
  removeAllowWord
};
