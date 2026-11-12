#!/usr/bin/env node
'use strict';
/**
 * Cut-through Score: re-score with the editor's own labels. No Resolve, no Claude.
 *
 *   node scripts/ct-rescore.js <run folder>/score_<LABEL>.json <run folder>/score_<LABEL>_changes.csv
 *
 * In the changes sheet, fill `your_label` only where Compare's label is wrong:
 *   edge  = the start or end of a word (given back or trimmed)
 *   words = whole words put back or cut
 *   pause = air only, no word touched
 *   other = anything else
 * Blank rows keep Compare's label. Writes score_<LABEL>_relabeled.json / .html beside the score.
 */
const fs = require('fs');
const path = require('path');
const sc = require('../electron/workers/cut_through_score');

const [scorePath, csvPath] = process.argv.slice(2);
if (!scorePath || !csvPath) {
  console.error('Usage: node scripts/ct-rescore.js <score_LABEL.json> <score_LABEL_changes.csv>');
  process.exit(1);
}
const score = JSON.parse(fs.readFileSync(scorePath, 'utf8'));
const { score: out, applied, unknown, unmatched } = sc.rescore(score, fs.readFileSync(csvPath, 'utf8'));
const base = scorePath.replace(/\.json$/i, '_relabeled');
fs.writeFileSync(`${base}.json`, JSON.stringify(out, null, 1), 'utf8');
fs.writeFileSync(`${base}.html`, sc.reportHtml({ label: `${out.label} (relabeled)`, rows: out.timelines, sum: out.totals, notes: out.notes || [] }), 'utf8');
console.log(sc.reportLines(out.totals).join('\n'));
console.log(`\n${applied} label(s) applied${unknown.length ? `; not understood: ${[...new Set(unknown)].join(', ')} (use ${sc.LABELS.join(' / ')})` : ''}`
  + `${unmatched ? `; ${unmatched} row(s) didn't match a change` : ''}`);
console.log(`Wrote ${path.basename(base)}.json and .html`);
