const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const JOB_STATES = Object.freeze({
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled'
});

function createPersistence(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const hasFile = fs.existsSync(filePath);
  if (!hasFile) {
    fs.writeFileSync(filePath, '', 'utf8');
  }

  const writeRecord = record => {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const hydrate = () => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const jobs = new Map();
    lines.forEach(line => {
      try {
        const record = JSON.parse(line);
        if (!record?.job_id || !record?.snapshot) return;
        jobs.set(record.job_id, record.snapshot);
      } catch (_error) {
        // ignore malformed historic lines
      }
    });
    return jobs;
  };

  return { writeRecord, hydrate };
}

class JobEngine {
  constructor(options) {
    this.sendStepRequest = options.sendStepRequest;
    this.forceKillWorker = options.forceKillWorker;
    this.persistence = createPersistence(options.persistencePath);
    this.emitter = new EventEmitter();
    this.jobs = this.persistence.hydrate();
    this.idempotencyIndex = new Map();
    this.queuesByOwner = {
      resolve: [],
      media: [],
      platform: []
    };
    this.activeCounts = {
      resolve: 0,
      media: 0,
      platform: 0
    };
    this.concurrency = {
      resolve: 1,
      media: Math.max(1, Number(options.mediaConcurrency || 2)),
      platform: Math.max(1, Number(options.platformConcurrency || 2))
    };

    for (const [jobId, snapshot] of this.jobs.entries()) {
      if (snapshot.idempotency_key) {
        this.idempotencyIndex.set(snapshot.idempotency_key, jobId);
      }
    }
  }

  subscribe(listener) {
    this.emitter.on('event', listener);
    return () => this.emitter.removeListener('event', listener);
  }

  emitJobEvent(event) {
    this.emitter.emit('event', event);
  }

  persist(job) {
    this.jobs.set(job.job_id, job);
    this.persistence.writeRecord({
      ts: Date.now(),
      job_id: job.job_id,
      state: job.state,
      snapshot: job
    });
  }

  listJobs() {
    return Array.from(this.jobs.values());
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  submit(plan) {
    if (plan?.idempotency_key && this.idempotencyIndex.has(plan.idempotency_key)) {
      const existing = this.jobs.get(this.idempotencyIndex.get(plan.idempotency_key));
      return existing;
    }

    const job = {
      job_id: plan.job_id || randomUUID(),
      preset_id: plan.preset_id || null,
      idempotency_key: plan.idempotency_key || null,
      dependencies: Array.isArray(plan.dependencies) ? plan.dependencies : [],
      retry_policy: plan.retry_policy || { max_attempts: 1, backoff_ms: 0 },
      timeout: Number(plan.timeout || 0),
      created_at: Date.now(),
      started_at: null,
      finished_at: null,
      state: JOB_STATES.queued,
      steps: (plan.steps || []).map(step => ({
        step_id: step.step_id || randomUUID(),
        cmd: step.cmd,
        worker: step.worker,
        payload: step.payload || {},
        depends_on: Array.isArray(step.depends_on) ? step.depends_on : [],
        state: JOB_STATES.queued,
        attempt: 0,
        started_at: null,
        finished_at: null,
        output: null,
        error: null,
        cancellation: { requested: false }
      })),
      outputs: [],
      errors: []
    };

    if (job.idempotency_key) {
      this.idempotencyIndex.set(job.idempotency_key, job.job_id);
    }

    this.persist(job);
    this.emitJobEvent({ type: 'job_state', job_id: job.job_id, state: job.state });
    this.enqueueJob(job.job_id);
    return job;
  }

  enqueueJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || ![JOB_STATES.queued, JOB_STATES.running].includes(job.state)) return;
    if (job.state === JOB_STATES.queued) {
      job.state = JOB_STATES.running;
      job.started_at = job.started_at || Date.now();
      this.persist(job);
      this.emitJobEvent({ type: 'job_state', job_id: job.job_id, state: job.state });
    }
    this.scheduleRunnableSteps(job);
  }

  scheduleRunnableSteps(job) {
    const completed = new Set(job.steps.filter(s => s.state === JOB_STATES.succeeded).map(s => s.step_id));
    const failed = job.steps.some(s => s.state === JOB_STATES.failed);
    const canceled = job.steps.some(s => s.state === JOB_STATES.canceled);

    if (failed) return this.finalize(job, JOB_STATES.failed);
    if (canceled) return this.finalize(job, JOB_STATES.canceled);

    const queued = job.steps.filter(step => step.state === JOB_STATES.queued);
    if (queued.length === 0) {
      return this.finalize(job, JOB_STATES.succeeded);
    }

    queued.forEach(step => {
      const ready = step.depends_on.every(dep => completed.has(dep));
      if (!ready) return;
      step.state = 'dispatching';
      this.persist(job);
      this.queuesByOwner[step.worker].push({ job_id: job.job_id, step_id: step.step_id });
      this.emitJobEvent({
        type: 'step_progress',
        job_id: job.job_id,
        step_id: step.step_id,
        worker: step.worker,
        state: 'queued'
      });
      this.drainOwnerQueue(step.worker);
    });
  }

  drainOwnerQueue(worker) {
    const limit = this.concurrency[worker] || 1;
    while (this.activeCounts[worker] < limit && this.queuesByOwner[worker].length > 0) {
      const next = this.queuesByOwner[worker].shift();
      this.runStep(next.job_id, next.step_id).catch(() => null);
    }
  }

  async runStep(jobId, stepId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const step = job.steps.find(entry => entry.step_id === stepId);
    if (!step) return;

    step.state = JOB_STATES.running;
    step.attempt += 1;
    step.started_at = Date.now();
    this.activeCounts[step.worker] += 1;
    this.persist(job);
    this.emitJobEvent({ type: 'step_progress', job_id: jobId, step_id: stepId, worker: step.worker, state: 'running' });

    const timeoutMs = job.timeout > 0 ? job.timeout : 0;
    const maxAttempts = Math.max(1, Number(job.retry_policy?.max_attempts || 1));
    let timeoutHandle = null;
    let forcedKillHandle = null;

    try {
      const requestPromise = this.sendStepRequest({
        worker: step.worker,
        cmd: step.cmd,
        ...step.payload,
        trace_id: `${job.job_id}:${step.step_id}:${step.attempt}`
      });

      const guarded = timeoutMs > 0
        ? Promise.race([
          requestPromise,
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`step timeout after ${timeoutMs}ms`)), timeoutMs);
          })
        ])
        : requestPromise;

      const response = await guarded;
      if (!response?.ok) {
        throw new Error(response?.error?.message || response?.error || 'step failed');
      }

      step.state = JOB_STATES.succeeded;
      step.finished_at = Date.now();
      step.output = response.data;
      job.outputs.push({ step_id: step.step_id, output: step.output, finished_at: step.finished_at });
      this.emitJobEvent({
        type: 'step_progress',
        job_id: jobId,
        step_id: stepId,
        worker: step.worker,
        state: 'succeeded',
        output: step.output,
        timing_ms: step.finished_at - step.started_at
      });
    } catch (error) {
      const isCancelled = step.cancellation.requested;
      if (isCancelled) {
        step.state = JOB_STATES.canceled;
        step.error = { message: 'canceled' };
      } else if (step.attempt < maxAttempts) {
        step.state = JOB_STATES.queued;
        step.error = { message: error.message };
      } else {
        step.state = JOB_STATES.failed;
        step.error = { message: error.message };
        job.errors.push({ step_id: step.step_id, error: step.error, failed_at: Date.now() });
      }
      step.finished_at = Date.now();
      this.emitJobEvent({
        type: 'step_progress',
        job_id: jobId,
        step_id: stepId,
        worker: step.worker,
        state: step.state,
        error: step.error,
        timing_ms: step.finished_at - (step.started_at || step.finished_at)
      });

      if (isCancelled) {
        forcedKillHandle = setTimeout(() => {
          this.forceKillWorker(step.worker, `job ${jobId} canceled`);
        }, 1000);
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forcedKillHandle) clearTimeout(forcedKillHandle);
      this.activeCounts[step.worker] = Math.max(0, this.activeCounts[step.worker] - 1);
      this.persist(job);
      this.drainOwnerQueue(step.worker);
      this.scheduleRunnableSteps(job);
    }
  }

  finalize(job, state) {
    if ([JOB_STATES.succeeded, JOB_STATES.failed, JOB_STATES.canceled].includes(job.state)) return;
    job.state = state;
    job.finished_at = Date.now();
    this.persist(job);
    this.emitJobEvent({
      type: 'job_state',
      job_id: job.job_id,
      state: job.state,
      timing_ms: job.finished_at - (job.started_at || job.finished_at)
    });
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: 'job not found' };

    job.steps.forEach(step => {
      if ([JOB_STATES.queued, JOB_STATES.running, 'dispatching'].includes(step.state)) {
        step.cancellation.requested = true;
        if (step.state === JOB_STATES.queued || step.state === 'dispatching') {
          step.state = JOB_STATES.canceled;
          step.finished_at = Date.now();
        }
      }
    });

    this.persist(job);
    this.scheduleRunnableSteps(job);
    return { ok: true, message: 'cancellation requested', job_id: jobId };
  }

  resumeRecoverableJobs() {
    for (const job of this.jobs.values()) {
      if ([JOB_STATES.queued, JOB_STATES.running].includes(job.state)) {
        job.steps.forEach(step => {
          if (step.state === JOB_STATES.running || step.state === 'dispatching') {
            step.state = JOB_STATES.queued;
            step.started_at = null;
            step.finished_at = null;
          }
        });
        this.persist(job);
        this.enqueueJob(job.job_id);
      }
    }
  }
}

module.exports = { JobEngine, JOB_STATES };
