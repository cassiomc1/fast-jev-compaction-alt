#!/usr/bin/env node
/**
 * Deterministic schema and manifest validation for Claude Code and Codex
 * plugin files. Validates plugin manifests, marketplaces, skills, and hooks.
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

// 3. Validate the portable/Codex manifests and skill entrypoint.
const portablePluginJson = readJson('plugin.json');
const codexPluginJson = readJson('.codex-plugin/plugin.json');
for (const [label, manifest] of [
  ['plugin.json', portablePluginJson],
  ['.codex-plugin/plugin.json', codexPluginJson],
]) {
  assert(manifest.name === pkg.name, `${label} name (${manifest.name}) must match package.json (${pkg.name})`);
  const manifestBaseVersion = typeof manifest.version === 'string'
    ? manifest.version.split('+', 1)[0]
    : manifest.version;
  assert(manifestBaseVersion === pkg.version, `${label} base version (${manifestBaseVersion}) must match package.json (${pkg.version})`);
  assert(typeof manifest.description === 'string' && manifest.description.length > 0, `${label} must have description`);
}
assert(typeof portablePluginJson.$schema === 'string', 'plugin.json must declare the Agent Plugins schema');
assert(codexPluginJson.skills === './skills/', '.codex-plugin/plugin.json must point at ./skills/');
assert(
  codexPluginJson.version === pkg.version || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+codex\.[a-z0-9-]+$/.test(codexPluginJson.version),
  `.codex-plugin/plugin.json version must be a semver version with an optional +codex cachebuster, got ${codexPluginJson.version}`,
);
const skillPath = resolve(root, 'skills/fast-jev-compaction/SKILL.md');
assert(existsSync(skillPath), 'skills/fast-jev-compaction/SKILL.md is missing');
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8');
  assert(/^---\n[\s\S]*?^name:\s*fast-jev-compaction\s*$/m.test(skill), 'Codex skill frontmatter must declare name: fast-jev-compaction');
  assert(/^description:\s*.+$/m.test(skill), 'Codex skill frontmatter must declare a description');
}

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

// 4. Validate marketplace.json
const marketplace = readJson('.claude-plugin/marketplace.json');
assert(marketplace.name === pkg.name, `marketplace.json name mismatch: ${marketplace.name}`);
assert(marketplace.owner?.name === 'cassiomc1', `marketplace.json owner must be cassiomc1`);
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace.json must list plugins');
assert(marketplace.plugins[0].name === pkg.name, `marketplace.json plugin name mismatch: ${marketplace.plugins[0].name}`);
assert(marketplace.plugins[0].version === pkg.version, `marketplace.json plugin version mismatch: ${marketplace.plugins[0].version}`);

// 5. Validate hooks/hooks.json
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
