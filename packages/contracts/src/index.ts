/**
 * Top-level barrel for `@cortexos/contracts`. Re-exports the public
 * surface: primitives, query conventions, error model, audit chain
 * helpers, approval flow, and every entity.
 *
 * Consumers should import from `@cortexos/contracts` (or the
 * `/entities`, `/schemas`, `/errors` sub-paths) and never reach into
 * individual source files.
 *
 * @module
 */

// Foundational modules.
export * from './primitives.js';
export * from './query.js';
export * from './errors.js';
export * from './audit.js';
export * from './approval.js';

// Every entity type and its Zod schema.
export * from './entities/index.js';
