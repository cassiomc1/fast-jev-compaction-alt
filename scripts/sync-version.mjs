#!/usr/bin/env node
/**
 * sync-version.mjs — keep version numbers in sync across package.json,
 * .claude-plugin/plugin.json, .claude-plugin/marketplace.json, and
 * package-lock.json.
 *
 * Usage: node scripts/sync-version.mjs [version]
 *   If no version is given, reads from package.json and applies it everywhere.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function writeJson(path, obj) {
  const full = resolve(root, path);
  const tmp = full + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  copyFileSync(tmp, full);
  unlinkSync(tmp);
}

const pkg = readJson('package.json');
const targetVersion = process.argv[2] ?? pkg.version;

if (!targetVersion) {
  console.error('No version specified and package.json has no version.');
  process.exit(1);
}

// Validate semver-ish
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(targetVersion)) {
  console.error(`Invalid version: ${targetVersion}`);
  process.exit(1);
}

let changed = [];

// package.json
if (pkg.version !== targetVersion) {
  pkg.version = targetVersion;
  writeJson('package.json', pkg);
  changed.push('package.json');
}

// plugin.json
const pluginJsonPath = '.claude-plugin/plugin.json';
if (existsSync(resolve(root, pluginJsonPath))) {
  const pluginJson = readJson(pluginJsonPath);
  if (pluginJson.version !== targetVersion) {
    pluginJson.version = targetVersion;
    writeJson(pluginJsonPath, pluginJson);
    changed.push(pluginJsonPath);
  }
}

// marketplace.json
const marketplaceJsonPath = '.claude-plugin/marketplace.json';
if (existsSync(resolve(root, marketplaceJsonPath))) {
  const marketplaceJson = readJson(marketplaceJsonPath);
  let marketplaceChanged = false;
  if (marketplaceJson.plugins?.[0]?.version !== targetVersion) {
    if (marketplaceJson.plugins?.[0]) {
      marketplaceJson.plugins[0].version = targetVersion;
    }
    marketplaceChanged = true;
  }
  if (marketplaceChanged) {
    writeJson(marketplaceJsonPath, marketplaceJson);
    changed.push(marketplaceJsonPath);
  }
}

// package-lock.json
const lockPath = 'package-lock.json';
if (existsSync(resolve(root, lockPath))) {
  const lock = readJson(lockPath);
  let lockChanged = false;
  if (lock.version !== targetVersion) {
    lock.version = targetVersion;
    lockChanged = true;
  }
  if (lock.packages?.['']?.version !== targetVersion) {
    if (lock.packages?.['']) {
      lock.packages[''].version = targetVersion;
    }
    lockChanged = true;
  }
  if (lockChanged) {
    writeJson(lockPath, lock);
    changed.push(lockPath);
  }
}

if (changed.length === 0) {
  console.log(`Version already synced at ${targetVersion}.`);
} else {
  console.log(`Synced version to ${targetVersion} in:`);
  for (const f of changed) console.log(`  - ${f}`);
}