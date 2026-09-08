import { existsSync, readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('package scripts exist', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const s of ['dev', 'build', 'test', 'migrate', 'corpus', 'check-links']) {
      expect(pkg.scripts[s], s).toBeTruthy();
    }
  });
  it('config files exist', () => {
    for (const f of ['astro.config.mjs', 'vitest.config.ts', '.dev.vars.example', 'src/styles/global.css']) {
      expect(existsSync(f), f).toBe(true);
    }
  });
});
