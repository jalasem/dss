import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// End-to-end coverage for the `dss config export|import [path]` grouping
// (Phase 3 · Task 2): the optional path argument, the legacy top-level
// `export`/`import` aliases delegating to the exact same handlers with a
// deprecation warning on stderr, and the default path being preserved when
// no path argument is given.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('dss config export|import CLI', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;
  let homedirPreloadPath: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-config-cli-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  /** `<space><enter>` toggles-selects the first (only) checkbox choice and
   * confirms — drives `checkbox()`'s interactive selection non-interactively. */
  const SELECT_FIRST_AND_CONFIRM = ' \n';

  function runCli(args: string[], input?: string): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, ['--require', homedirPreloadPath, CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: process.env,
      input
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '../..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    homedirPreloadPath = path.join(temporaryHome, 'homedir-preload.cjs');

    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{
        name: 'personal',
        email: 'personal@example.com',
        userName: 'Personal User',
        sshKeyPath: ''
      }]
    });
    await fs.writeFile(
      homedirPreloadPath,
      `const os = require('os'); os.homedir = () => ${JSON.stringify(temporaryHome)};\n`
    );
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('`dss config export <path>` writes to the given path, not the default ~/dss-export.json', async () => {
    const customPath = path.join(temporaryHome, 'custom-export.json');
    const defaultPath = path.join(temporaryHome, 'dss-export.json');

    const result = runCli(['config', 'export', customPath], SELECT_FIRST_AND_CONFIRM);

    expect(result.status).toBe(0);
    expect(await fs.pathExists(customPath)).toBe(true);
    expect(await fs.pathExists(defaultPath)).toBe(false);
    const exported = await fs.readJson(customPath);
    expect(exported.spaces[0].name).toBe('personal');
  });

  it('`dss config export` (no path) falls back to the default ~/dss-export.json', async () => {
    const defaultPath = path.join(temporaryHome, 'dss-export.json');

    const result = runCli(['config', 'export'], SELECT_FIRST_AND_CONFIRM);

    expect(result.status).toBe(0);
    expect(await fs.pathExists(defaultPath)).toBe(true);
  });

  it('`dss config import <path>` reads from the given path', async () => {
    const customPath = path.join(temporaryHome, 'custom-import.json');
    await fs.outputJson(customPath, {
      spaces: [{ name: 'imported', email: 'i@x.com', userName: 'I' }]
    });

    // The "Import N new identities?" confirm is required-affirm (Phase 4 ·
    // Task 1) — piped stdin is non-interactive by definition and is never
    // read for it any more, so -y replaces the old piped 'y\n'.
    const result = runCli(['config', 'import', customPath, '-y']);

    expect(result.status).toBe(0);
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.identities.some((identity: { name: string }) => identity.name === 'imported')).toBe(true);
  });

  it('the legacy "export" alias still works and prints a deprecation warning pointing at "dss config export"', async () => {
    const result = runCli(['export'], SELECT_FIRST_AND_CONFIRM);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss export" is deprecated');
    expect(result.stderr).toContain('Use "dss config export"');
    expect(await fs.pathExists(path.join(temporaryHome, 'dss-export.json'))).toBe(true);
  });

  it('the legacy "import" alias still works and prints a deprecation warning pointing at "dss config import"', async () => {
    const customPath = path.join(temporaryHome, 'legacy-import.json');
    await fs.outputJson(customPath, {
      spaces: [{ name: 'legacy-imported', email: 'l@x.com', userName: 'L' }]
    });

    const result = runCli(['import', customPath, '-y']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss import" is deprecated');
    expect(result.stderr).toContain('Use "dss config import"');
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.identities.some((identity: { name: string }) => identity.name === 'legacy-imported')).toBe(true);
  });

  it('`dss batch`, `dss bulk`, and `dss onboard` no longer exist', () => {
    for (const cmd of ['batch', 'bulk', 'onboard']) {
      const result = runCli([cmd]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown command');
    }
  });
});
