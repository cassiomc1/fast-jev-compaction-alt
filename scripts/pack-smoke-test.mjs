#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

console.log('Building dist before packaging check...');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

// Verify declaration files exist
const requiredDts = [
  'dist/index.d.ts',
  'dist/plugin.d.ts',
  'dist/opencode.d.ts',
  'dist/codex.d.ts',
  'dist/client.d.ts',
  'dist/compact.d.ts',
  'dist/request.d.ts',
  'dist/state.d.ts',
  'dist/types.d.ts',
];

for (const rel of requiredDts) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing expected declaration file: ${rel}`);
  }
}
console.log('All declaration files verified.');

for (const rel of ['plugin.json', '.codex-plugin/plugin.json', 'skills/fast-jev-compaction/SKILL.md']) {
  if (!fs.existsSync(path.join(root, rel))) {
    throw new Error(`Missing Codex plugin asset: ${rel}`);
  }
}
console.log('Codex plugin assets verified.');

// Pack tarball
console.log('Running npm pack...');
const tarballName = execSync('npm pack', { cwd: root, encoding: 'utf8' }).trim().split('\n').pop().trim();
const tarballPath = path.resolve(root, tarballName);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-jev-smoke-'));

try {
  console.log(`Testing packed tarball in isolated directory: ${tmpDir}`);
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'smoke-test',
      version: '1.0.0',
      type: 'module',
    }),
  );

  execSync(`npm install "${tarballPath}" @opencode-ai/plugin`, { cwd: tmpDir, stdio: 'inherit' });

  // Test dynamic imports of all exported entrypoints
  const testScript = `
    import * as root from 'fast-jev-compaction-alt';
    import * as plugin from 'fast-jev-compaction-alt/plugin';
    import * as server from 'fast-jev-compaction-alt/server';
    import * as opencode from 'fast-jev-compaction-alt/opencode';
    import * as codex from 'fast-jev-compaction-alt/codex';

    if (typeof root.compact !== 'function') throw new Error('Root export missing compact');
    if (typeof plugin.FastJevCompactionPlugin !== 'function') throw new Error('Plugin export missing FastJevCompactionPlugin');
    if (typeof server.FastJevCompactionPlugin !== 'function') throw new Error('Server export missing FastJevCompactionPlugin');
    if (typeof opencode.openCodeToMessages !== 'function') throw new Error('Opencode export missing openCodeToMessages');
    if (typeof codex.codexToMessages !== 'function') throw new Error('Codex export missing codexToMessages');
    if (typeof root.askQuestions !== 'function') throw new Error('Root export missing askQuestions');
    if (typeof root.evaluateAutonomy !== 'function') throw new Error('Root export missing evaluateAutonomy');

    const fs = await import('node:fs');
    for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'skills/fast-jev-compaction/SKILL.md']) {
      if (!fs.existsSync(new URL('node_modules/fast-jev-compaction-alt/' + file, import.meta.url))) {
        throw new Error('Packed Codex plugin asset missing: ' + file);
      }
    }

    console.log('All entrypoint imports verified successfully.');
  `;

  fs.writeFileSync(path.join(tmpDir, 'test-import.mjs'), testScript);
  execSync('node test-import.mjs', { cwd: tmpDir, stdio: 'inherit' });

  console.log('Smoke pack test PASSED.');
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.unlinkSync(tarballPath);
  } catch {}
}
