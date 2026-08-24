import {
  setJsonMode,
  isJsonMode,
  jsonData,
  jsonSetData,
  jsonFail,
  flushJson,
  _resetJsonStateForTests,
} from '../../src/commands/jsonOutput';

// Phase 4 · Task 3 — unit matrix for jsonOutput.ts: the single seam every
// command's `--json` payload flows through. Covers the module's own
// contract in isolation (single-object guarantee, first-error-wins,
// idempotent flush, `ok` derived from process.exitCode at flush time) —
// CLI-level parse-stdout-as-JSON coverage lives in tests/jsonCli.test.ts.

describe('jsonOutput', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetJsonStateForTests();
    process.exitCode = undefined;
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    _resetJsonStateForTests();
    process.exitCode = undefined;
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

  it('flushJson() emits exactly one JSON object on success (exitCode 0/undefined): {ok:true, command, data}', () => {
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

  it('jsonSetData() REPLACES the pending data wholesale — an earlier jsonData() patch is dropped, not merged', () => {
    setJsonMode('new');
    jsonData({ switched: 'stray-from-an-inner-call', previous: 'also-stray' });
    jsonSetData({ created: { name: 'x' }, key: null, switched: true });

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written.data).toEqual({ created: { name: 'x' }, key: null, switched: true });
    expect(Object.keys(written.data).sort()).toEqual(['created', 'key', 'switched']);
  });

  // --- ok mirrors process.exitCode at flush time -------------------------

  it('ok is true when process.exitCode is 0/undefined, regardless of whether jsonData was called', () => {
    setJsonMode('ls');
    process.exitCode = undefined;

    flushJson();

    expect(JSON.parse(writeSpy.mock.calls[0][0] as string).ok).toBe(true);
  });

  it('ok is false when process.exitCode is non-zero, even if jsonFail() was never called (falls back to a generic message)', () => {
    setJsonMode('doctor');
    jsonData({ identity: 'x', checks: [{ name: 'Key', status: 'error', detail: 'missing' }] });
    process.exitCode = 1;

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written).toEqual({
      ok: false,
      command: 'doctor',
      error: { message: 'command failed' },
    });
    // The data payload built via jsonData is NOT present on an ok:false object.
    expect(written.data).toBeUndefined();
  });

  it('jsonFail() records the FIRST error message only — later calls are no-ops (still requires a non-zero exitCode to surface as ok:false)', () => {
    setJsonMode('rm');
    jsonFail('first failure');
    jsonFail('second failure (should be ignored)');
    process.exitCode = 1;

    flushJson();

    const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(written).toEqual({
      ok: false,
      command: 'rm',
      error: { message: 'first failure' },
    });
  });

  it('a non-zero exitCode wins over any jsonData() — the object is ok:false with no `data` key, using the recorded jsonFail message', () => {
    setJsonMode('new');
    jsonData({ created: { name: 'x' } });
    jsonFail('identity already exists');
    process.exitCode = 1;

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
