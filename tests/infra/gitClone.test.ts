import { execFile } from 'child_process';
import { runGitClone, GitCloneError } from '../../src/infra/gitClone';

jest.mock('child_process');

const mockExecFile = execFile as unknown as jest.Mock;

function fakeChild(stderrPipeSpy: jest.Mock = jest.fn()): { stderr: { pipe: jest.Mock } } {
  return { stderr: { pipe: stderrPipeSpy } };
}

describe('infra/gitClone — runGitClone', () => {
  it('calls execFile with ["clone", "--", url, dest] and no env override for a plain clone', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild();
    });

    await runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: false });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--', 'https://github.com/acme/api.git', '/tmp/dest'],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );
    const passedOptions = mockExecFile.mock.calls[0][2];
    expect(passedOptions.env).toBeUndefined();
  });

  // Security (argument injection / argv flag smuggling): the `--`
  // end-of-options separator must sit BEFORE `url` so git can never parse a
  // malicious-looking url/dest as a flag (e.g. `--upload-pack=<cmd>`),
  // defense-in-depth alongside parseGitUrl's own `-`-prefix rejection.
  it('always inserts "--" immediately before the url, even for an ssh clone with env set', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild();
    });

    await runGitClone('git@github.com:acme/api.git', '/tmp/dest', {
      env: { ...process.env, GIT_SSH_COMMAND: "ssh -i '/mock/key' -o IdentitiesOnly=yes" },
      interactive: false
    });

    const passedArgs = mockExecFile.mock.calls[0][1];
    expect(passedArgs).toEqual(['clone', '--', 'git@github.com:acme/api.git', '/tmp/dest']);
    expect(passedArgs.indexOf('--')).toBe(passedArgs.indexOf('git@github.com:acme/api.git') - 1);
  });

  it('passes GIT_SSH_COMMAND via env for a keyed ssh clone', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild();
    });

    const env = { ...process.env, GIT_SSH_COMMAND: "ssh -i '/mock/key' -o IdentitiesOnly=yes" };
    await runGitClone('git@github.com:acme/api.git', '/tmp/dest', { env, interactive: false });

    const passedOptions = mockExecFile.mock.calls[0][2];
    expect(passedOptions.env).toBe(env);
    expect(passedOptions.env.GIT_SSH_COMMAND).toContain('/mock/key');
  });

  it('env is absent for an https clone even when interactive', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild();
    });

    await runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: true });

    const passedOptions = mockExecFile.mock.calls[0][2];
    expect(passedOptions.env).toBeUndefined();
  });

  it('env is absent for a local path clone', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild();
    });

    await runGitClone('/tmp/fixtures/source.git', '/tmp/dest', { interactive: false });

    const passedOptions = mockExecFile.mock.calls[0][2];
    expect(passedOptions.env).toBeUndefined();
  });

  it('pipes stderr to process.stderr in interactive mode', async () => {
    const pipeSpy = jest.fn();
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild(pipeSpy);
    });

    await runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: true });

    expect(pipeSpy).toHaveBeenCalledWith(process.stderr);
  });

  it('does not pipe stderr in non-interactive (JSON/PLAIN) mode', async () => {
    const pipeSpy = jest.fn();
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(null, '', '');
      return fakeChild(pipeSpy);
    });

    await runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: false });

    expect(pipeSpy).not.toHaveBeenCalled();
  });

  it('rejects with a GitCloneError carrying the stderr tail on failure', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(new Error('exit 128'), '', 'fatal: repository not found\n');
      return fakeChild();
    });

    await expect(
      runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: false })
    ).rejects.toBeInstanceOf(GitCloneError);
  });

  it('the rejected GitCloneError carries the trimmed stderr tail', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(new Error('exit 128'), '', 'fatal: repository not found\n');
      return fakeChild();
    });

    await expect(
      runGitClone('https://github.com/acme/api.git', '/tmp/dest', { interactive: false })
    ).rejects.toMatchObject({ stderrTail: 'fatal: repository not found' });
  });
});
