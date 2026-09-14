import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_SOCKET_TIMEOUT_MS,
  IDLE_SOCKET_TIMEOUT_MS,
  ImapConnectionClosedError,
} from '../src/imap.js';
import { makeListenerOnError } from '../src/index.js';

describe('IMAP socket timeout constants', () => {
  it('exports the IDLE-specific timeout at 120_000 ms', () => {
    expect(IDLE_SOCKET_TIMEOUT_MS).toBe(120_000);
  });

  it('keeps the IDLE timer wide enough to survive the 29_000 ms silent wait', () => {
    expect(IDLE_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(4 * 29_000);
  });

  it('exports the command-mode timeout at 30_000 ms', () => {
    expect(COMMAND_SOCKET_TIMEOUT_MS).toBe(30_000);
  });
});

describe('makeListenerOnError', () => {
  it('writes the account slug and error to stderr for unexpected errors', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onError = makeListenerOnError('test-slug');
    onError(new Error('boom'));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('listener error'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('test-slug'));

    writeSpy.mockRestore();
  });

  it('writes a reconnect notice to stdout (not stderr) for ImapConnectionClosedError', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const onError = makeListenerOnError('test-slug');
    onError(new ImapConnectionClosedError('test-slug'));

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test-slug'));

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
