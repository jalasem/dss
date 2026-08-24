import { fail } from '../../src/commands/fail';
import { UIHelper } from '../../src/commands/ui';
import { EXIT_CODES } from '../../src/core/exitCodes';
import { setJsonMode, isJsonMode, flushJson, _resetJsonStateForTests } from '../../src/commands/jsonOutput';

// Phase 4 · Task 3 — fail() -> jsonFail() wiring: fail()'s message must
// still reach the JSON error object even though UIHelper.error() (which it
// also calls) is itself suppressed on stdout in JSON mode.

describe('fail()', () => {
  let errorSpy: jest.SpyInstance;
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    errorSpy = jest.spyOn(UIHelper, 'error');
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
    _resetJsonStateForTests();
  });

  it('sets process.exitCode to 1 and calls UIHelper.error(), unchanged from before --json existed', () => {
    fail('identity not found');
    expect(errorSpy).toHaveBeenCalledWith('identity not found');
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });

  it('in JSON mode, records the message for the JSON error object even though UIHelper.error() prints nothing', () => {
    setJsonMode('use');
    expect(isJsonMode()).toBe(true);

    fail('identity "nope" not found');
    flushJson();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'use',
      error: { message: 'identity "nope" not found' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });

  it('a second fail() call in the same JSON-mode invocation does not overwrite the first message', () => {
    setJsonMode('rm');
    fail('first problem');
    fail('second problem (should be ignored for the JSON object)');
    flushJson();

    expect(JSON.parse(writeSpy.mock.calls[0][0] as string).error.message).toBe('first problem');
  });
});
