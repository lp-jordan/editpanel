const path = require('path');
const assert = require('assert');
const { RecipeCatalog } = require('../electron/orchestrator/recipes');

const catalog = new RecipeCatalog({ filePath: path.join(__dirname, '..', 'electron', 'orchestrator', 'recipes.json') });
const recipes = catalog.list();

assert.ok(Array.isArray(recipes) && recipes.length >= 3, 'expected at least three recipes');
assert.ok(recipes.find(recipe => recipe.id === 'transcribe_folder'), 'transcribe_folder recipe missing');
assert.ok(recipes.find(recipe => recipe.id === 'lp_base_export_round1'), 'lp_base_export_round1 recipe missing');
assert.ok(recipes.find(recipe => recipe.id === 'prepare_project'), 'prepare_project recipe missing');

console.log(`recipe catalog validation passed (${recipes.length} recipes)`);
