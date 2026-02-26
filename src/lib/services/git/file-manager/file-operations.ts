/**
 * File operations module
 * Handles reading, writing, and listing files in git repositories
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { join } from 'path';
import logger from '../../logger.js';
import { sanitizeError } from '../../../utils/security.js';
import { validateFilePath, validateRepoName, validateNpub } from './path-validator.js';
import type { FileEntry, FileContent } from '../file-manager.js';
import { repoCache, RepoCache } from '../repo-cache.js';

export interface FileListOptions {
  npub: string;
  repoName: string;
  ref?: string;
  path?: string;
  repoPath: string;
}

export interface FileReadOptions {
  npub: string;
  repoName: string;
  filePath: string;
  ref?: string;
  repoPath: string;
}

/**
 * List files and directories in a repository at a given path
 */
export async function listFiles(options: FileListOptions): Promise<FileEntry[]> {
  const { npub, repoName, ref = 'HEAD', path = '', repoPath } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }
  
  const pathValidation = validateFilePath(path);
  if (!pathValidation.valid) {
    throw new Error(`Invalid file path: ${pathValidation.error}`);
  }

  // Check cache first (cache for 2 minutes)
  const cacheKey = RepoCache.fileListKey(npub, repoName, ref, path);
  const cached = repoCache.get<FileEntry[]>(cacheKey);
  if (cached !== null) {
    logger.debug({ npub, repoName, path, ref, cachedCount: cached.length }, 'Returning cached file list');
    return cached;
  }

  const git: SimpleGit = simpleGit(repoPath);
  
  try {
    const gitPath = path ? (path.endsWith('/') ? path : `${path}/`) : '.';
    logger.operation('Listing files', { npub, repoName, path, ref, gitPath });
    
    let tree: string;
    try {
      tree = await git.raw(['ls-tree', '-l', ref, gitPath]);
    } catch (lsTreeError) {
      const errorMsg = lsTreeError instanceof Error ? lsTreeError.message : String(lsTreeError);
      const errorStr = String(lsTreeError).toLowerCase();
      const errorMsgLower = errorMsg.toLowerCase();
      
      const isEmptyBranchError = 
        errorMsgLower.includes('not a valid object') ||
        errorMsgLower.includes('not found') ||
        errorMsgLower.includes('bad revision') ||
        errorMsgLower.includes('ambiguous argument') ||
        errorStr.includes('not a valid object') ||
        errorStr.includes('not found') ||
        errorStr.includes('bad revision') ||
        errorStr.includes('ambiguous argument') ||
        (errorMsgLower.includes('fatal:') && (errorMsgLower.includes('master') || errorMsgLower.includes('refs/heads')));
      
      if (isEmptyBranchError) {
        logger.debug({ npub, repoName, path, ref }, 'Branch has no commits, returning empty list');
        const emptyResult: FileEntry[] = [];
        repoCache.set(cacheKey, emptyResult, 30 * 1000);
        return emptyResult;
      }
      
      logger.error({ error: lsTreeError, npub, repoName, path, ref }, 'Unexpected error from git ls-tree');
      throw lsTreeError;
    }
    
    if (!tree || !tree.trim()) {
      const emptyResult: FileEntry[] = [];
      repoCache.set(cacheKey, emptyResult, 30 * 1000);
      return emptyResult;
    }

    const entries: FileEntry[] = [];
    const lines = tree.trim().split('\n').filter(line => line.length > 0);
    const normalizedPath = path ? (path.endsWith('/') ? path : `${path}/`) : '';

    for (const line of lines) {
      const tabIndex = line.lastIndexOf('\t');
      if (tabIndex === -1) {
        // Space-separated format
        const match = line.match(/^(\d+)\s+(\w+)\s+(\w+)\s+(\d+|-)\s+(.+)$/);
        if (match) {
          const [, , type, , size, gitPath] = match;
          const { fullPath, displayName } = parseGitPath(gitPath, normalizedPath, path);
          
          entries.push({
            name: displayName,
            path: fullPath,
            type: type === 'tree' ? 'directory' : 'file',
            size: size !== '-' ? parseInt(size, 10) : undefined
          });
        }
      } else {
        // Tab-separated format (standard)
        const beforeTab = line.substring(0, tabIndex);
        const gitPath = line.substring(tabIndex + 1);
        const match = beforeTab.match(/^(\d+)\s+(\w+)\s+(\w+)\s+(\d+|-)$/);
        if (match) {
          const [, , type, , size] = match;
          const { fullPath, displayName } = parseGitPath(gitPath, normalizedPath, path);
          
          entries.push({
            name: displayName,
            path: fullPath,
            type: type === 'tree' ? 'directory' : 'file',
            size: size !== '-' ? parseInt(size, 10) : undefined
          });
        }
      }
    }

    const sortedEntries = entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Cache the result (cache for 2 minutes)
    repoCache.set(cacheKey, sortedEntries, 2 * 60 * 1000);
    
    logger.operation('Files listed', { npub, repoName, path, count: sortedEntries.length });
    return sortedEntries;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStr = String(error).toLowerCase();
    const errorMsgLower = errorMsg.toLowerCase();
    
    const isEmptyBranchError = 
      errorMsgLower.includes('not a valid object') ||
      errorMsgLower.includes('not found') ||
      errorMsgLower.includes('bad revision') ||
      errorMsgLower.includes('ambiguous argument') ||
      errorStr.includes('not a valid object') ||
      errorStr.includes('not found') ||
      errorStr.includes('bad revision') ||
      errorStr.includes('ambiguous argument') ||
      (errorMsgLower.includes('fatal:') && (errorMsgLower.includes('master') || errorMsgLower.includes('refs/heads')));
    
    if (isEmptyBranchError) {
      logger.debug({ npub, repoName, path, ref }, 'Branch has no commits, returning empty list');
      const emptyResult: FileEntry[] = [];
      repoCache.set(cacheKey, emptyResult, 30 * 1000);
      return emptyResult;
    }
    
    logger.error({ error, repoPath, ref }, 'Error listing files');
    throw new Error(`Failed to list files: ${errorMsg}`);
  }
}

/**
 * Parse git path and extract full path and display name
 */
function parseGitPath(
  gitPath: string,
  normalizedPath: string,
  originalPath: string
): { fullPath: string; displayName: string } {
  let fullPath: string;
  let displayName: string;
  
  if (normalizedPath) {
    if (gitPath.startsWith(normalizedPath)) {
      fullPath = gitPath;
      const relativePath = gitPath.slice(normalizedPath.length);
      const cleanRelative = relativePath.replace(/^\/+|\/+$/g, '');
      displayName = cleanRelative.split('/')[0] || cleanRelative;
    } else {
      fullPath = join(originalPath, gitPath);
      displayName = gitPath.split('/').pop() || gitPath;
    }
  } else {
    fullPath = gitPath;
    displayName = gitPath.split('/')[0];
  }
  
  return { fullPath, displayName };
}

/**
 * Get file content from a repository
 */
export async function getFileContent(options: FileReadOptions): Promise<FileContent> {
  const { npub, repoName, filePath, ref = 'HEAD', repoPath } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }
  
  const pathValidation = validateFilePath(filePath);
  if (!pathValidation.valid) {
    throw new Error(`Invalid file path: ${pathValidation.error}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Reading file', { npub, repoName, filePath, ref });
    
    let content: string;
    try {
      content = await git.raw(['show', `${ref}:${filePath}`]);
    } catch (gitError: any) {
      const stderr = gitError?.stderr || gitError?.message || String(gitError);
      const stderrLower = stderr.toLowerCase();
      
      if (stderrLower.includes('not found') || 
          stderrLower.includes('no such file') || 
          stderrLower.includes('does not exist') ||
          stderrLower.includes('fatal:') ||
          stderr.includes('pathspec') ||
          stderr.includes('ambiguous argument') ||
          stderr.includes('unknown revision') ||
          stderr.includes('bad revision')) {
        throw new Error(`File not found: ${filePath} at ref ${ref}`);
      }
      
      throw new Error(`Git command failed: ${stderr}`);
    }
    
    if (content === undefined || content === null) {
      throw new Error(`File not found: ${filePath} at ref ${ref}`);
    }
    
    const encoding = 'utf-8';
    const size = Buffer.byteLength(content, encoding);

    logger.operation('File read', { npub, repoName, filePath, size });
    return {
      content,
      encoding,
      size
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorLower = errorMessage.toLowerCase();
    const errorString = String(error);
    const errorStringLower = errorString.toLowerCase();
    
    if (errorLower.includes('not found') || 
        errorStringLower.includes('not found') ||
        errorLower.includes('no such file') || 
        errorStringLower.includes('no such file') ||
        errorLower.includes('does not exist') ||
        errorStringLower.includes('does not exist') ||
        errorLower.includes('fatal:') ||
        errorStringLower.includes('fatal:') ||
        errorMessage.includes('pathspec') ||
        errorString.includes('pathspec') ||
        errorMessage.includes('ambiguous argument') ||
        errorString.includes('ambiguous argument') ||
        errorString.includes('unknown revision') ||
        errorString.includes('bad revision')) {
      throw new Error(`File not found: ${filePath} at ref ${ref}`);
    }
    
    logger.error({ error, repoPath, filePath, ref }, 'Error reading file');
    throw new Error(`Failed to read file: ${errorMessage}`);
  }
}
