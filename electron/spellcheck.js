const fs = require('fs');
const path = require('path');
const nspell = require('nspell');

let dictionary;

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
        return
          typeof spell.correct === 'function' && typeof spell.suggest === 'function'
            ? spell
            : { correct: () => true, suggest: () => [] };
      }
      return { correct: () => true, suggest: () => [] };
    });
  }
  return spellPromise;
}

async function misspellings(_, text) {
  const words = String(text)
    .split(/\W+/)
    .filter(Boolean);
  try {
    const spell = await loadSpell();
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

module.exports = { misspellings, suggestions };
