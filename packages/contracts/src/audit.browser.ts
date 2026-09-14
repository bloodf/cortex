/**
 * Browser stub for @cortexos/contracts/audit.
 *
 * The audit module uses node:crypto (createHash, timingSafeEqual) for server-side
 * chain hashing and verification. These are inherently server-only and must NEVER
 * run in the browser bundle. If any client-side code accidentally imports this
 * module, throw a clear error.
 *
 * The package.json `browser` export condition points here for any bundler that
 * respects the condition. The actual server-side import path is
 * `./dist/audit.js` via the `default` condition.
 */
throw new Error(
  '@cortexos/contracts/audit cannot be imported in the browser. ' +
    'Chain hashing + verification are server-only (node:crypto). ' +
    'Use defineRoute({ auth: "admin", surface: "audit", action: "verify", handler }) ' +
    'or call the server endpoint via +server.ts / form action instead.',
);
