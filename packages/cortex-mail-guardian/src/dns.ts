import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { getMailGuardianDnsServers } from './env.js';

const configuredServers = getMailGuardianDnsServers()
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const resolver = configuredServers.length > 0 ? new dns.promises.Resolver() : null;
resolver?.setServers(configuredServers);

const lookupWithFallback = ((
  hostname: string,
  options:
    | dns.LookupOptions
    | ((
        err: NodeJS.ErrnoException | null,
        address: string | dns.LookupAddress[],
        family?: number,
      ) => void),
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void => {
  let opts: dns.LookupOptions;
  let cb: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void;
  if (typeof options === 'function') {
    cb = options;
    opts = {};
  } else {
    opts = options ?? {};
    cb = callback;
  }
  dns.promises
    .lookup(hostname, opts)
    .then((result) => {
      if (Array.isArray(result)) {
        cb(null, result);
      } else {
        cb(null, result.address, result.family);
      }
    })
    .catch(async (err) => {
      if (!resolver) {
        cb(err, '', 0);
        return;
      }
      try {
        const addresses = await resolver.resolve4(hostname);
        if (!addresses[0]) throw err;
        if (opts.all) {
          cb(
            null,
            addresses.map((item) => ({ address: item, family: 4 })),
          );
        } else {
          cb(null, addresses[0], 4);
        }
      } catch {
        cb(err, '', 0);
      }
    });
}) as LookupFunction;

export default lookupWithFallback;
