/**
 * File Manager - Modular exports
 * Re-exports all file manager functionality from focused modules
 */

// Re-export types
export type {
  FileEntry,
  FileContent,
  Commit,
  Diff,
  Tag
} from '../file-manager.js';

// Re-export modules
export * from './worktree-manager.js';
export * from './path-validator.js';
export * from './file-operations.js';
export * from './branch-operations.js';
export * from './write-operations.js';
export * from './commit-operations.js';
export * from './tag-operations.js';