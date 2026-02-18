const assert = require('assert');
const { execFileSync } = require('child_process');
const contracts = require('../electron/orchestrator/contracts');

const pythonResult = execFileSync('python', ['-c', `
import json
from helper.commands import RESOLVE_HANDLERS, MEDIA_HANDLERS
print(json.dumps({"resolve": sorted(RESOLVE_HANDLERS.keys()), "media": sorted(MEDIA_HANDLERS.keys())}))
`], { encoding: 'utf8' }).trim();

const handlers = JSON.parse(pythonResult);

const expectedResolve = ['connect', 'create_project_bins', 'lp_base_export'];
const expectedMedia = ['transcribe_folder', 'test_cuda'];

for (const cmd of expectedResolve) {
  assert.strictEqual(contracts.commandOwner(cmd), contracts.WORKERS.resolve, `${cmd} must route to resolve worker`);
  assert.ok(handlers.resolve.includes(cmd), `${cmd} must be implemented in resolve worker`);
}

for (const cmd of expectedMedia) {
  assert.strictEqual(contracts.commandOwner(cmd), contracts.WORKERS.media, `${cmd} must route to media worker`);
  assert.ok(handlers.media.includes(cmd), `${cmd} must be implemented in media worker`);
}

assert.strictEqual(contracts.commandOwner('transcribe'), contracts.WORKERS.media, 'transcribe must route to media worker');
console.log('worker routing regression checks passed');
