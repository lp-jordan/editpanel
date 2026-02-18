const path = require('path');
const { StepCacheStore } = require('../electron/orchestrator/step_cache');

const args = process.argv.slice(2);
let cachePath = process.env.STEP_CACHE_PATH || path.join(__dirname, '..', 'electron', '.state', 'step-cache.json');
let fingerprint = null;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--cache' && args[i + 1]) {
    cachePath = path.resolve(args[i + 1]);
    i += 1;
  } else if (!fingerprint) {
    fingerprint = args[i];
  }
}

const store = new StepCacheStore(cachePath);
store.invalidate(fingerprint);
if (fingerprint) {
  console.log(`invalidated fingerprint ${fingerprint} in ${cachePath}`);
} else {
  console.log(`invalidated all step cache entries in ${cachePath}`);
}
