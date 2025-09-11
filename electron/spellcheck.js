const fs = require('fs');
const path = require('path');
const nspell = require('nspell');
const dictionary = require('dictionary-en-us');

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

async function misspellings(_, text) {
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
}

module.exports = { misspellings };
