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

for (const cmd of expectedResolve) {
  assert.strictEqual(contracts.commandOwner(cmd), contracts.WORKERS.resolve, `${cmd} must route to resolve worker`);
  assert.ok(handlers.resolve.includes(cmd), `${cmd} must be implemented in resolve worker`);
}

console.log('worker routing regression checks passed');
