/**
 * Shared callbacks object for repo operations
 * Consolidates common callback patterns to reduce duplication
 */

import type { RepoState } from '../stores/repo-state.js';
import { rewriteImagePaths as rewriteImagePathsUtil } from './file-processing.js';
import { findReadmeFile as findReadmeFileUtil } from './file-helpers.js';

export interface FileCallbacks {
  getUserEmail: () => Promise<string>;
  getUserName: () => Promise<string>;
  loadFiles: (path: string) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  renderFileAsHtml: (content: string, ext: string) => Promise<void>;
  applySyntaxHighlighting: (content: string, ext: string) => Promise<void>;
  findReadmeFile: (fileList: Array<{ name: string; path: string; type: 'file' | 'directory' }>) => { name: string; path: string; type: 'file' | 'directory' } | null;
  rewriteImagePaths: (html: string, filePath: string | null) => string;
}

export interface BranchCallbacks {
  loadBranches: () => Promise<void>;
  loadFiles: (path: string) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  loadReadme: () => Promise<void>;
  loadCommitHistory: () => Promise<void>;
  loadDocumentation: () => Promise<void>;
}

/**
 * Create file callbacks from state and functions
 */
export function createFileCallbacks(
  state: RepoState,
  getUserEmail: () => Promise<string>,
  getUserName: () => Promise<string>,
  loadFiles: (path: string) => Promise<void>,
  loadFile: (path: string) => Promise<void>,
  renderFileAsHtml: (content: string, ext: string) => Promise<void>,
  applySyntaxHighlighting: (content: string, ext: string) => Promise<void>
): FileCallbacks {
  return {
    getUserEmail,
    getUserName,
    loadFiles,
    loadFile,
    renderFileAsHtml,
    applySyntaxHighlighting,
    findReadmeFile: findReadmeFileUtil,
    rewriteImagePaths: (html: string, filePath: string | null) => {
      const branch = state.git.currentBranch || state.git.defaultBranch || null;
      return rewriteImagePathsUtil(html, filePath, state.npub, state.repo, branch);
    }
  };
}

/**
 * Create branch callbacks from functions
 */
export function createBranchCallbacks(
  loadBranches: () => Promise<void>,
  loadFiles: (path: string) => Promise<void>,
  loadFile: (path: string) => Promise<void>,
  loadReadme: () => Promise<void>,
  loadCommitHistory: () => Promise<void>,
  loadDocumentation: () => Promise<void>
): BranchCallbacks {
  return {
    loadBranches,
    loadFiles,
    loadFile,
    loadReadme,
    loadCommitHistory,
    loadDocumentation
  };
}
