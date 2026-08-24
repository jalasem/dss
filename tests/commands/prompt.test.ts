import chalk from 'chalk';
import { loadStore } from '../../src/infra/store';
import { resolveAppliesHere } from '../../src/infra/identityResolution';
import { promptSegment } from '../../src/commands/prompt';
import { setJsonMode, flushJson, _resetJsonStateForTests } from '../../src/commands/jsonOutput';
import { IIdentity, IStoreV2 } from '../../src/core/types';

// `dss prompt` (Phase 5 · Task 4): the fast, cache-free shell-prompt
// identity segment. Unit-level coverage for the output matrix (rich/PLAIN/
// --source/--json) and the never-break wrapper against MOCKED loadStore/
// resolveAppliesHere — CLI-level coverage (real spawned process, real
// corrupt-store/git-fail fixtures, real bound/rule/global sources) lives in
// tests/commands/promptCli.test.ts.

jest.mock('../../src/infra/store', () => ({
  loadStore: jest.fn()
}));
jest.mock('../../src/infra/identityResolution', () => ({
  resolveAppliesHere: jest.fn()
}));

const mockLoadStore = loadStore as jest.MockedFunction<typeof loadStore>;
const mockResolveAppliesHere = resolveAppliesHere as jest.MockedFunction<typeof resolveAppliesHere>;

const work: IIdentity = { name: 'work', email: 'work@example.com', userName: 'Work User', host: 'github.com' };
const emptyStore: IStoreV2 = { version: 2, identities: [], bindings: [], rules: [] };

// Jest's stdout isn't a TTY, so UIHelper is PLAIN by default (matches
// ui.test.ts's own helper) - flip both stdout.isTTY and chalk's detected
// color-support level to exercise the rich-mode branch too, around an
// awaited promptSegment() call.
async function withRichMode(fn: () => Promise<void>): Promise<void> {
  const originalIsTTY = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;
  const originalChalkLevel = chalk.level;
  (process.stdout as any).isTTY = true;
  delete process.env.NO_COLOR;
  chalk.level = 3;
  try {
    await fn();
  } finally {
    (process.stdout as any).isTTY = originalIsTTY;
    chalk.level = originalChalkLevel;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
  }
}

function loggedLines(): string[] {
  return (console.log as jest.Mock).mock.calls.flat().filter((v): v is string => typeof v === 'string');
}

describe('commands/prompt: promptSegment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    _resetJsonStateForTests();
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    _resetJsonStateForTests();
    process.exitCode = undefined;
  });

  describe('output matrix', () => {
    it('PLAIN (default Jest stdout, not a TTY): bare "name", no glyph, no color', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });

      await promptSegment();

      expect(loggedLines()).toEqual(['work']);
      expect(process.exitCode).toBeUndefined();
    });

    it('rich (TTY): accent-glyph-prefixed name, colored', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });

      await withRichMode(() => promptSegment());

      const [line] = loggedLines();
      expect(line).toContain('work');
      expect(line).toMatch(/●/); // the accent glyph
      expect(line).toMatch(/\x1b\[/); // an ANSI escape (colored)
    });

    it('empty output (exit 0) when no identity applies here at all', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: null, source: null });

      await promptSegment();

      expect(loggedLines()).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it('--source appends a dim "(repo)" hint in rich mode for a bound identity', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'bound' });

      await withRichMode(() => promptSegment({ source: true }));

      const [line] = loggedLines();
      expect(line).toContain('work');
      expect(line).toContain('(repo)');
    });

    it('--source appends a plain "(rule)" hint in PLAIN mode, no color', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'rule' });

      await promptSegment({ source: true });

      expect(loggedLines()).toEqual(['work (rule)']);
    });

    it('--source with a global source appends "(global)"', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });

      await promptSegment({ source: true });

      expect(loggedLines()).toEqual(['work (global)']);
    });

    it('--source is off by default: no hint appended even though a source is available', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });

      await promptSegment();

      expect(loggedLines()).toEqual(['work']);
    });
  });

  describe('--json payload', () => {
    it('{ identity: name, source } when an identity resolves', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });
      setJsonMode('prompt');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await promptSegment();
      flushJson();

      const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
      expect(written).toEqual({ ok: true, command: 'prompt', data: { identity: 'work', source: 'global' } });
    });

    it('{ identity: null, source: null } when nothing applies here', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: null, source: null });
      setJsonMode('prompt');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await promptSegment();
      flushJson();

      const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
      expect(written).toEqual({ ok: true, command: 'prompt', data: { identity: null, source: null } });
    });

    it('exact key set is {identity, source} - nothing extra', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'rule' });
      setJsonMode('prompt');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await promptSegment();
      flushJson();

      const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
      expect(written.ok).toBe(true);
      expect(Object.keys(written.data).sort()).toEqual(['identity', 'source']);
      expect(written.data).toEqual({ identity: 'work', source: 'rule' });
    });

    it('--json still emits nothing decorative to stdout alongside the JSON object (UIHelper.print is JSON-mode-guarded)', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockResolvedValue({ identity: work, source: 'global' });
      setJsonMode('prompt');

      await promptSegment();

      expect(loggedLines()).toEqual([]);
    });
  });

  describe('the never-break wrapper', () => {
    it('loadStore() throwing (e.g. an unsupported/corrupt store) degrades to empty output, exit 0, no throw', async () => {
      mockLoadStore.mockRejectedValue(new Error('Unsupported config version 3'));

      await expect(promptSegment()).resolves.toBeUndefined();

      expect(loggedLines()).toEqual([]);
      expect(process.exitCode).toBe(0);
    });

    it('resolveAppliesHere() throwing (e.g. a git failure it could not itself swallow) degrades to empty output, exit 0, no throw', async () => {
      mockLoadStore.mockResolvedValue(emptyStore);
      mockResolveAppliesHere.mockRejectedValue(new Error('git: fatal error'));

      await expect(promptSegment()).resolves.toBeUndefined();

      expect(loggedLines()).toEqual([]);
      expect(process.exitCode).toBe(0);
    });

    it('an error mid-flight still forces process.exitCode to 0 even if something set it non-zero first', async () => {
      process.exitCode = 1;
      mockLoadStore.mockRejectedValue(new Error('boom'));

      await promptSegment();

      expect(process.exitCode).toBe(0);
    });

    it('--json mode on an error still emits the single best-effort {identity:null, source:null} object, ok:true, exit 0', async () => {
      mockLoadStore.mockRejectedValue(new Error('boom'));
      setJsonMode('prompt');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await promptSegment();
      flushJson();

      expect(process.exitCode).toBe(0);
      const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
      expect(written).toEqual({ ok: true, command: 'prompt', data: { identity: null, source: null } });
    });
  });
});
