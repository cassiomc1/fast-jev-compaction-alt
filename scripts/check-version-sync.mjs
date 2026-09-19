#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const pkg = readJson('package.json');
const plugin = readJson('.claude-plugin/plugin.json');
const portablePlugin = readJson('plugin.json');
const codexPlugin = readJson('.codex-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');

const marketplacePlugin = marketplace.plugins?.[0];

const errors = [];

if (pkg.name !== 'fast-jev-compaction-alt') {
  errors.push(`package.json name should be fast-jev-compaction-alt, got ${pkg.name}`);
}

if (plugin.name !== pkg.name) {
  errors.push(`plugin.json name (${plugin.name}) does not match package.json name (${pkg.name})`);
}

for (const [label, manifest] of [['plugin.json', portablePlugin], ['.codex-plugin/plugin.json', codexPlugin]]) {
  if (manifest.name !== pkg.name) {
    errors.push(`${label} name (${manifest.name}) does not match package.json (${pkg.name})`);
  }
  const manifestBaseVersion = typeof manifest.version === 'string' ? manifest.version.split('+', 1)[0] : manifest.version;
  if (pkg.version !== manifestBaseVersion) {
    errors.push(`Version mismatch: package.json (${pkg.version}) vs ${label} base version (${manifestBaseVersion})`);
  }
}

if (marketplacePlugin?.name !== pkg.name) {
  errors.push(`marketplace.json plugin name (${marketplacePlugin?.name}) does not match package.json name (${pkg.name})`);
}

if (pkg.version !== plugin.version) {
  errors.push(`Version mismatch: package.json (${pkg.version}) vs plugin.json (${plugin.version})`);
}

if (pkg.version !== marketplacePlugin?.version) {
  errors.push(`Version mismatch: package.json (${pkg.version}) vs marketplace.json plugin (${marketplacePlugin?.version})`);
}

if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  const lock = readJson('package-lock.json');
  if (lock.name !== pkg.name) {
    errors.push(`package-lock.json name (${lock.name}) does not match package.json name (${pkg.name})`);
  }
  if (lock.packages?.['']?.name && lock.packages[''].name !== pkg.name) {
    errors.push(`package-lock.json packages[''].name (${lock.packages[''].name}) does not match package.json name (${pkg.name})`);
  }
  if (lock.version !== pkg.version) {
    errors.push(`package-lock.json version (${lock.version}) does not match package.json version (${pkg.version})`);
  }
}

if (errors.length > 0) {
  console.error('Version/metadata sync check failed:');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(`Version and metadata in sync: ${pkg.name}@${pkg.version}`);
