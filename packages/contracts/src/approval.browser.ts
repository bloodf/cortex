/**
 * Browser stub for @cortexos/contracts/approval.
 *
 * The approval module uses node:crypto (createHmac, timingSafeEqual, randomBytes)
 * for server-side action-binding and token signing. These are inherently
 * server-only and must NEVER run in the browser bundle. If any client-side
 * code accidentally imports this module, throw a clear error.
 *
 * The package.json `browser` export condition points here for any bundler
 * that respects the condition (Vite, Rollup, Webpack all do). The actual
 * server-side import path is `./dist/approval.js` via the `default` condition.
 */
throw new Error(
  '@cortexos/contracts/approval cannot be imported in the browser. ' +
    'Action-binding + token signing are server-only (node:crypto). ' +
    'Use defineRoute({ auth, surface, action, handler }) or call the server ' +
    'endpoint via +server.ts / form action instead.',
);
