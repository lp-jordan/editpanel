const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { WORKERS, commandOwner, UserError } = require('./contracts');

const VAR_PATTERN = /^\$\{([^}]+)\}$/;

function getByPath(source, dottedPath) {
  if (!dottedPath) return source;
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, source);
}

function interpolateValue(value, context) {
  if (typeof value === 'string') {
    const match = value.match(VAR_PATTERN);
    if (match) {
      const resolved = getByPath(context, match[1]);
      return resolved;
    }
    return value.replace(/\$\{([^}]+)\}/g, (_full, tokenPath) => {
      const resolved = getByPath(context, tokenPath);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map(entry => interpolateValue(entry, context));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, context)])
    );
  }

  return value;
}

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new UserError('recipe must be an object');
  }
  if (!recipe.id || typeof recipe.id !== 'string') {
    throw new UserError('recipe.id must be a non-empty string');
  }
  if (!recipe.version || typeof recipe.version !== 'string') {
    throw new UserError(`recipe ${recipe.id} must define version`);
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new UserError(`recipe ${recipe.id} must have at least one step`);
  }

  const knownWorkers = new Set(Object.values(WORKERS));
  const stepIds = new Set();

  recipe.steps.forEach(step => {
    if (!step || typeof step !== 'object') {
      throw new UserError(`recipe ${recipe.id} contains an invalid step entry`);
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new UserError(`recipe ${recipe.id} step missing id`);
    }
    if (stepIds.has(step.id)) {
      throw new UserError(`recipe ${recipe.id} has duplicate step id: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.worker || !knownWorkers.has(step.worker)) {
      throw new UserError(`recipe ${recipe.id} step ${step.id} has unknown worker: ${step.worker}`);
    }
    if (!step.command || typeof step.command !== 'string') {
      throw new UserError(`recipe ${recipe.id} step ${step.id} missing command`);
    }
    const owner = commandOwner(step.command);
    if (!owner) {
      throw new UserError(`recipe ${recipe.id} step ${step.id} has unknown command: ${step.command}`);
    }
    if (owner !== step.worker) {
      throw new UserError(`recipe ${recipe.id} step ${step.id} misroutes command ${step.command}: expected ${owner}, got ${step.worker}`);
    }
  });

  recipe.steps.forEach(step => {
    const deps = Array.isArray(step.depends_on) ? step.depends_on : [];
    deps.forEach(dep => {
      if (!stepIds.has(dep)) {
        throw new UserError(`recipe ${recipe.id} step ${step.id} references invalid dependency: ${dep}`);
      }
      if (dep === step.id) {
        throw new UserError(`recipe ${recipe.id} step ${step.id} cannot depend on itself`);
      }
    });
  });
}

class RecipeCatalog {
  constructor(options = {}) {
    const filePath = options.filePath || path.join(__dirname, 'recipes.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    const parsed = ext === '.yaml' || ext === '.yml' ? yaml.load(raw) : JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new UserError('recipes file must be an array');
    }

    this.recipes = new Map();
    parsed.forEach(recipe => {
      validateRecipe(recipe);
      if (this.recipes.has(recipe.id)) {
        throw new UserError(`duplicate recipe id: ${recipe.id}`);
      }
      this.recipes.set(recipe.id, recipe);
    });
  }

  list() {
    return Array.from(this.recipes.values()).map(recipe => ({
      id: recipe.id,
      version: recipe.version,
      description: recipe.description || '',
      inputs: recipe.inputs || {},
      defaults: recipe.defaults || {},
      outputs: recipe.outputs || {}
    }));
  }

  get(recipeId) {
    return this.recipes.get(recipeId) || null;
  }

  buildPlan(recipeId, suppliedInput = {}, options = {}) {
    const recipe = this.get(recipeId);
    if (!recipe) {
      throw new UserError(`unknown recipe: ${recipeId}`);
    }

    const defaults = recipe.defaults && typeof recipe.defaults === 'object' ? recipe.defaults : {};
    const input = {
      ...defaults,
      ...(suppliedInput && typeof suppliedInput === 'object' ? suppliedInput : {})
    };

    const context = {
      recipe: { id: recipe.id, version: recipe.version },
      defaults,
      input,
      steps: {}
    };

    const steps = recipe.steps.map(step => ({
      step_id: step.id,
      worker: step.worker,
      cmd: step.command,
      depends_on: Array.isArray(step.depends_on) ? step.depends_on : [],
      payload: interpolateValue(step.payload || {}, context),
      cache_policy: interpolateValue(step.cache_policy || { enabled: false, ttl_ms: 0 }, context),
      output_contract: interpolateValue(step.output_contract || { type: 'non_null' }, context),
      tool_versions: interpolateValue(step.tool_versions || {}, context),
      retry_policy: interpolateValue(step.retry_policy || {}, context)
    }));

    return {
      preset_id: recipe.id,
      idempotency_key: options.idempotency_key || null,
      timeout: Number(options.timeout_ms || 0),
      retry_policy: options.retry_policy || { max_attempts: 1, backoff_ms: 0 },
      steps
    };
  }

  materializeOutputs(recipeId, job) {
    const recipe = this.get(recipeId);
    if (!recipe) return {};

    const stepOutputMap = {};
    (job?.steps || []).forEach(step => {
      stepOutputMap[step.step_id] = step.output || {};
    });

    const context = {
      recipe: { id: recipe.id, version: recipe.version },
      steps: stepOutputMap,
      job: {
        id: job?.job_id,
        state: job?.state
      }
    };

    return interpolateValue(recipe.outputs || {}, context);
  }
}

module.exports = {
  RecipeCatalog,
  validateRecipe,
  interpolateValue
};
