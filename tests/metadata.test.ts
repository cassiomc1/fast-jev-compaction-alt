/**
 * Metadata sync and identity tests.
 * Verifies that name, version, repository URLs are consistent across all config files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

describe('Metadata consistency', () => {
  const pkg = readJson('package.json');

  it('package.json has correct name and repo', () => {
    expect(pkg.name).toBe('fast-jev-compaction-alt');
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'https://github.com/cassiomc1/fast-jev-compaction-alt.git',
      directory: ''
    });
    expect(pkg.bugs?.url).toBe('https://github.com/cassiomc1/fast-jev-compaction-alt/issues');
    expect(pkg.homepage).toBe('https://github.com/cassiomc1/fast-jev-compaction-alt#readme');
  });

  it('package.json and plugin.json versions match', () => {
    const pluginJson = readJson('.claude-plugin/plugin.json');
    expect(pluginJson.name).toBe('fast-jev-compaction-alt');
    expect(pluginJson.version).toBe(pkg.version);
  });

  it('marketplace.json matches package.json', () => {
    const marketplaceJson = readJson('.claude-plugin/marketplace.json');
    expect(marketplaceJson.name).toBe('fast-jev-compaction-alt');
    expect(marketplaceJson.owner.name).toBe('cassiomc1');
    expect(marketplaceJson.owner.url).toBe('https://github.com/cassiomc1/fast-jev-compaction-alt');
    expect(marketplaceJson.plugins[0].name).toBe('fast-jev-compaction-alt');
    expect(marketplaceJson.plugins[0].version).toBe(pkg.version);
  });

  it('package-lock.json version matches', () => {
    if (!existsSync(resolve(root, 'package-lock.json'))) return;
    const lock = readJson('package-lock.json');
    expect(lock.name).toBe('fast-jev-compaction-alt');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  it('plugin.ts SERVICE constant matches', () => {
    const pluginTs = readFileSync(resolve(root, 'src/plugin.ts'), 'utf8');
    expect(pluginTs).toContain("SERVICE = 'fast-jev-compaction-alt'");
    expect(pluginTs).toContain("plugin: 'fast-jev-compaction-alt'");
  });

  it('README installation instructions use fast-jev-compaction-alt', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    expect(readme).toContain('npm install fast-jev-compaction-alt');
    expect(readme).toContain('claude plugin marketplace add cassiomc1/fast-jev-compaction-alt');
    expect(readme).toContain('claude plugin install fast-jev-compaction-alt@fast-jev-compaction-alt');
  });

  it('plugin.json userConfig defaults match runtime constants', async () => {
    const { DEFAULT_OPTIONS } = await import('../src/compact.js');
    const { HOOK_DEFAULTS } = await import('../hooks/fast-jev.js');
    const pluginJson = readJson('.claude-plugin/plugin.json');
    const cfg = pluginJson.userConfig;

    expect(cfg.keepThreshold.default).toBe(DEFAULT_OPTIONS.keepThreshold);
    expect(cfg.preserveRecentMessages.default).toBe(DEFAULT_OPTIONS.preserveRecentMessages);
    expect(cfg.maxStateTokens.default).toBe(DEFAULT_OPTIONS.maxStateTokens);
    expect(cfg.maxRequestTokens.default).toBe(DEFAULT_OPTIONS.maxRequestTokens);
    expect(cfg.truncateHeadChars.default).toBe(DEFAULT_OPTIONS.truncateHeadChars);
    expect(cfg.compactAtPercent.default).toBe(HOOK_DEFAULTS.compactAtPercent);
    expect(cfg.minReductionRatio.default).toBe(HOOK_DEFAULTS.minReductionRatio);
  });
});