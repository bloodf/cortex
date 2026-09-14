import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMock = vi.hoisted(() => ({
  lookup: vi.fn(),
  setServers: vi.fn(),
  resolve4: vi.fn(),
}));

vi.mock('node:dns', () => ({
  default: {
    promises: {
      lookup: dnsMock.lookup,
      Resolver: class {
        setServers = dnsMock.setServers;
        resolve4 = dnsMock.resolve4;
      },
    },
  },
}));

async function lookupMailbox(): Promise<unknown[]> {
  // Re-import after each environment change: resolver configuration is captured at module load.
  const { default: lookup } = await import('../src/dns.js');
  // Callback adaptation also supports the package's Node 22.0 runtime floor.
  return new Promise((resolve) => {
    lookup('mail.private.invalid', {}, (...result: unknown[]) => resolve(result));
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('MAIL_GUARDIAN_DNS_SERVERS', undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('mailbox DNS privacy', () => {
  it('returns the system error without disclosing a failed private hostname to fallback DNS', async () => {
    const error = Object.assign(new Error('system lookup failed'), { code: 'ENOTFOUND' });
    dnsMock.lookup.mockRejectedValue(error);
    dnsMock.resolve4.mockResolvedValue(['192.0.2.25']);

    expect(await lookupMailbox()).toEqual([error, '', 0]);
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
  });

  it('uses fallback DNS only after an operator explicitly configures it', async () => {
    vi.stubEnv('MAIL_GUARDIAN_DNS_SERVERS', '192.0.2.53');
    dnsMock.lookup.mockRejectedValue(new Error('system lookup failed'));
    dnsMock.resolve4.mockResolvedValue(['192.0.2.25']);

    expect(await lookupMailbox()).toEqual([null, '192.0.2.25', 4]);
    expect(dnsMock.resolve4).toHaveBeenCalledWith('mail.private.invalid');
  });
});
