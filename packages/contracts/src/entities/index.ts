/**
 * Barrel export for every entity type and schema. Consumers should
 * import from `@cortexos/contracts/entities` rather than the individual
 * files — this keeps the import graph stable when entities are added
 * or split.
 *
 * @module
 */
export * from './user.js';
export * from './service.js';
export * from './system.js';
export * from './docker.js';
export * from './incus.js';
export * from './systemd.js';
export * from './alert.js';
export * from './approval.js';
export * from './terminal.js';
export * from './misc.js';
export * from './personalization.js';
