const fs = require('fs');
const path = require('path');

const DEFAULT_PREFERENCES = Object.freeze({
  recipe_defaults: {},
  worker_concurrency: {
    resolve: 1,
    media: 2,
    platform: 2
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ControlPlane {
  constructor(options) {
    this.jobEngine = options.jobEngine;
    this.recipeCatalog = options.recipeCatalog;
    this.preferencesPath = options.preferencesPath;
    this.eventLog = [];
    this.maxEvents = Number(options.maxEvents || 1000);
    this.preferences = this.loadPreferences();

    this.applyConcurrencyFromPreferences();

    this.unsubscribe = this.jobEngine.subscribe(event => {
      this.eventLog.push({ ...event, timestamp: Date.now() });
      if (this.eventLog.length > this.maxEvents) {
        this.eventLog = this.eventLog.slice(-this.maxEvents);
      }
    });
  }

  dispose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  loadPreferences() {
    try {
      if (!fs.existsSync(this.preferencesPath)) {
        return clone(DEFAULT_PREFERENCES);
      }
      const raw = fs.readFileSync(this.preferencesPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        recipe_defaults: typeof parsed?.recipe_defaults === 'object' && parsed.recipe_defaults
          ? parsed.recipe_defaults
          : {},
        worker_concurrency: {
          ...DEFAULT_PREFERENCES.worker_concurrency,
          ...(parsed?.worker_concurrency || {})
        }
      };
    } catch (_error) {
      return clone(DEFAULT_PREFERENCES);
    }
  }

  savePreferences() {
    fs.mkdirSync(path.dirname(this.preferencesPath), { recursive: true });
    fs.writeFileSync(this.preferencesPath, JSON.stringify(this.preferences, null, 2), 'utf8');
  }

  applyConcurrencyFromPreferences() {
    const c = this.preferences.worker_concurrency || {};
    this.jobEngine.setConcurrency({
      resolve: Number(c.resolve || 1),
      media: Number(c.media || 2),
      platform: Number(c.platform || 2)
    });
  }

  setPreferences(patch = {}) {
    const nextRecipeDefaults = {
      ...this.preferences.recipe_defaults,
      ...(patch.recipe_defaults || {})
    };

    const nextConcurrency = {
      ...this.preferences.worker_concurrency,
      ...(patch.worker_concurrency || {})
    };

    this.preferences = {
      recipe_defaults: nextRecipeDefaults,
      worker_concurrency: nextConcurrency
    };
    this.applyConcurrencyFromPreferences();
    this.savePreferences();

    return this.getPreferences();
  }

  getPreferences() {
    return clone(this.preferences);
  }

  estimateJobEta(job) {
    if (!job || !job.started_at || !Array.isArray(job.steps) || job.steps.length === 0) {
      return null;
    }

    const finishedSteps = job.steps.filter(step => Number(step.started_at) && Number(step.finished_at) && step.finished_at >= step.started_at);
    if (finishedSteps.length === 0) {
      return null;
    }

    const durations = finishedSteps.map(step => step.finished_at - step.started_at).filter(ms => ms > 0);
    if (durations.length === 0) {
      return null;
    }

    const avgMs = durations.reduce((acc, value) => acc + value, 0) / durations.length;
    const remaining = job.steps.filter(step => !['succeeded', 'failed', 'canceled'].includes(step.state)).length;
    return Math.round(avgMs * remaining);
  }

  buildDashboard() {
    const jobs = this.jobEngine.listJobs()
      .map(job => {
        const activeStep = job.steps.find(step => step.state === 'running') || null;
        return {
          job_id: job.job_id,
          preset_id: job.preset_id,
          state: job.state,
          created_at: job.created_at,
          started_at: job.started_at,
          finished_at: job.finished_at,
          active_step: activeStep
            ? {
              step_id: activeStep.step_id,
              worker: activeStep.worker,
              cmd: activeStep.cmd,
              state: activeStep.state,
              attempt: activeStep.attempt
            }
            : null,
          eta_ms: this.estimateJobEta(job)
        };
      })
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

    const logIndex = {};
    this.eventLog.forEach(event => {
      if (!event?.job_id) {
        return;
      }
      if (!logIndex[event.job_id]) {
        logIndex[event.job_id] = {};
      }
      const stepId = event.step_id || '_job';
      if (!logIndex[event.job_id][stepId]) {
        logIndex[event.job_id][stepId] = [];
      }
      logIndex[event.job_id][stepId].push(event);
    });

    return {
      generated_at: Date.now(),
      jobs,
      logs_by_job_step: logIndex
    };
  }

  launchRecipe(recipeId, input = {}, options = {}) {
    const recipeDefaults = this.preferences.recipe_defaults?.[recipeId] || {};
    const mergedInput = { ...recipeDefaults, ...input };
    const plan = this.recipeCatalog.buildPlan(recipeId, mergedInput, options);
    const job = this.jobEngine.submit(plan);
    return {
      job_id: job.job_id,
      preset_id: job.preset_id,
      state: job.state,
      input: mergedInput
    };
  }

  retryJob(jobId) {
    const existing = this.jobEngine.getJob(jobId);
    if (!existing) {
      return { ok: false, message: 'job not found' };
    }

    const recipeId = existing.preset_id;
    if (!recipeId) {
      return { ok: false, message: 'job has no recipe preset_id' };
    }

    const retryInput = existing.input || {};
    const launched = this.launchRecipe(recipeId, retryInput, { retry_of: jobId });
    return { ok: true, data: launched };
  }
}

module.exports = { ControlPlane };
