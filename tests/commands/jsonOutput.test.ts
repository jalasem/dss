import {
  setJsonMode,
  isJsonMode,
  jsonData,
  jsonFail,
  flushJson,
  _resetJsonStateForTests,
} from '../../src/commands/jsonOutput';

// Phase 4 · Task 3 — unit matrix for jsonOutput.ts: the single seam every
// command's `--json` payload flows through. Covers the module's own
// contract in isolation (single-object guarantee, first-error-wins,
// idempotent flush) — CLI-level parse-stdout-as-JSON coverage lives in
// tests/jsonCli.test.ts.

describe('jsonOutput', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetJsonStateForTests();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    _resetJsonStateForTests();
  });

  it('isJsonMode() is false until setJsonMode() is called', () => {
    expect(isJsonMode()).toBe(false);
    setJsonMode('ls');
    expect(isJsonMode()).toBe(true);
  });

  it('flushJson() is a total no-op when JSON mode was never turned on', () => {
    jsonData({ foo: 'bar' });
    flushJson();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('flushJson() emits exactly one JSON object on success: {ok:true, command, data}', () => {
    setJsonMode('ls');
    jsonData({ identities: [], active: null });

    flushJson();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0] as string;
    expect(written.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(written)).toEqual({
      ok: true,
      command: 'ls',
      data: { identities: [], active: null },
    });
  });

  it('jsonData() merges successive patches into one pending data object', () => {
    setJsonMode('use');
    jsonData({ switched: 'work' });
    jsonData({ previous: 'personal' });

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written.data).toEqual({ switched: 'work', previous: 'personal' });
  });

  it('jsonFail() records the FIRST error message only — later calls are no-ops', () => {
    setJsonMode('rm');
    jsonFail('first failure');
    jsonFail('second failure (should be ignored)');

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written).toEqual({
      ok: false,
      command: 'rm',
      error: { message: 'first failure' },
    });
  });

  it('a jsonFail() call wins over any jsonData() — the object is ok:false with no `data` key', () => {
    setJsonMode('new');
    jsonData({ created: { name: 'x' } });
    jsonFail('identity already exists');

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written.ok).toBe(false);
    expect(written.error).toEqual({ message: 'identity already exists' });
    expect(written.data).toBeUndefined();
  });

  it('flushJson() is idempotent — a second call emits nothing further', () => {
    setJsonMode('ls');
    jsonData({ identities: [] });

    flushJson();
    flushJson();
    flushJson();

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('setJsonMode() called again updates the reported command name (preAction hook re-resolving an alias to its primary)', () => {
    setJsonMode('dss'); // placeholder, from the --json option handler
    setJsonMode('ls');  // preAction hook resolving "list" -> "ls"
    jsonData({ identities: [] });

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written.command).toBe('ls');
  });
});
