#!/usr/bin/env node
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const ITERATIONS = Number(process.env.BASELINE_ITERATIONS || 5);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function runProbe() {
  return new Promise((resolve, reject) => {
    const cwd = path.join(__dirname, '..');
    const child = spawn('python', ['-m', 'helper.resolve_helper'], {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    const startedAt = process.hrtime.bigint();
    let firstLineAt = null;
    let contextSentAt = null;
    let contextDoneAt = null;

    const rl = readline.createInterface({ input: child.stdout });

    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGTERM');
      reject(new Error('probe timed out waiting for helper response'));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      rl.removeAllListeners();
    };

    rl.on('line', line => {
      const now = process.hrtime.bigint();
      if (!firstLineAt) {
        firstLineAt = now;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (!contextSentAt) {
        contextSentAt = process.hrtime.bigint();
        child.stdin.write(`${JSON.stringify({ id: 'baseline', cmd: 'context' })}\n`);
        return;
      }

      if (parsed && parsed.id === 'baseline') {
        contextDoneAt = now;
        cleanup();
        child.kill('SIGTERM');
        resolve({
          startupMs: Number(firstLineAt - startedAt) / 1e6,
          firstCommandMs: Number(contextDoneAt - contextSentAt) / 1e6
        });
      }
    });

    child.on('error', err => {
      cleanup();
      reject(err);
    });
  });
}

(async () => {
  const samples = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const sample = await runProbe();
    samples.push(sample);
  }

  const startup = samples.map(sample => sample.startupMs);
  const firstCmd = samples.map(sample => sample.firstCommandMs);

  const result = {
    iterations: ITERATIONS,
    samples,
    summary: {
      startupMs: {
        avg: average(startup),
        p95: percentile(startup, 95),
        max: Math.max(...startup)
      },
      firstCommandMs: {
        avg: average(firstCmd),
        p95: percentile(firstCmd, 95),
        max: Math.max(...firstCmd)
      }
    }
  };

  console.log(JSON.stringify(result, null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
