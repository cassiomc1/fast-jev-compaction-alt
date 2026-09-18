#!/usr/bin/env node
/**
 * Deterministic schema and manifest validation for Claude Code plugin files.
 * Validates .claude-plugin/plugin.json, marketplace.json, and hooks.
 * Runs in CI without requiring the external Claude CLI binary.
 * If the Claude CLI is present, also executes 'claude plugin validate --strict'.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readJson(rel) {
  const full = resolve(root, rel);
  if (!existsSync(full)) {
    throw new Error(`Missing required file: ${rel}`);
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse JSON in ${rel}: ${err.message}`);
  }
}

const errors = [];
function assert(condition, message) {
  if (!condition) errors.push(message);
}

console.log('Validating plugin and marketplace manifests...');

// 1. Validate package.json
const pkg = readJson('package.json');
assert(pkg.name === 'fast-jev-compaction-alt', `package.json name must be fast-jev-compaction-alt, got ${pkg.name}`);
assert(/^\d+\.\d+\.\d+/.test(pkg.version), `package.json version must be valid semver, got ${pkg.version}`);

// 2. Validate .claude-plugin/plugin.json
const pluginJson = readJson('.claude-plugin/plugin.json');
assert(pluginJson.name === pkg.name, `plugin.json name (${pluginJson.name}) must match package.json (${pkg.name})`);
assert(pluginJson.version === pkg.version, `plugin.json version (${pluginJson.version}) must match package.json (${pkg.version})`);
assert(typeof pluginJson.description === 'string' && pluginJson.description.length > 0, 'plugin.json must have description');
assert(pluginJson.author, 'plugin.json must have author');

const ALLOWED_CONFIG_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);
const DISALLOWED_CONFIG_KEYS = new Set(['minimum', 'maximum']); // Claude Code requires min/max

if (pluginJson.userConfig && typeof pluginJson.userConfig === 'object') {
  for (const [key, cfg] of Object.entries(pluginJson.userConfig)) {
    assert(ALLOWED_CONFIG_TYPES.has(cfg.type), `userConfig.${key}.type invalid: ${cfg.type}`);
    assert(typeof cfg.title === 'string' && cfg.title.length > 0, `userConfig.${key} missing title`);
    assert(typeof cfg.description === 'string' && cfg.description.length > 0, `userConfig.${key} missing description`);
    for (const badKey of DISALLOWED_CONFIG_KEYS) {
      assert(!(badKey in cfg), `userConfig.${key} must use 'min'/'max', not '${badKey}'`);
    }
    if (cfg.min !== undefined) {
      assert(typeof cfg.min === 'number', `userConfig.${key}.min must be number`);
    }
    if (cfg.max !== undefined) {
      assert(typeof cfg.max === 'number', `userConfig.${key}.max must be number`);
    }
  }
} else {
  errors.push('plugin.json must declare userConfig object');
}

// 3. Validate marketplace.json
const marketplace = readJson('.claude-plugin/marketplace.json');
assert(marketplace.name === pkg.name, `marketplace.json name mismatch: ${marketplace.name}`);
assert(marketplace.owner?.name === 'cassiomc1', `marketplace.json owner must be cassiomc1`);
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace.json must list plugins');
assert(marketplace.plugins[0].name === pkg.name, `marketplace.json plugin name mismatch: ${marketplace.plugins[0].name}`);
assert(marketplace.plugins[0].version === pkg.version, `marketplace.json plugin version mismatch: ${marketplace.plugins[0].version}`);

// 4. Validate hooks/hooks.json
const hooks = readJson('hooks/hooks.json');
assert(Array.isArray(hooks.modules) && hooks.modules.length > 0, 'hooks.json must declare modules array');

if (errors.length > 0) {
  console.error('Validation failed with errors:');
  for (const err of errors) console.error(`  ✘ ${err}`);
  process.exit(1);
}

console.log('Local schema and manifest validation passed.');

// Check if Claude CLI is available
let hasClaude = false;
try {
  execSync('which claude', { stdio: 'ignore' });
  hasClaude = true;
} catch {
  // Not found
}

if (hasClaude) {
  console.log('Running official Claude Code CLI validation (--strict)...');
  try {
    execSync('claude plugin validate --strict .claude-plugin/plugin.json', { stdio: 'inherit' });
    console.log('Official Claude CLI validation passed.');
  } catch {
    console.error('Official Claude CLI validation failed.');
    process.exit(1);
  }
} else {
  console.log('Note: Claude CLI (claude) not present in PATH; local deterministic schema checks succeeded.');
}
