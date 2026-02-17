/**
 * File manager for git repositories
 * Handles reading, writing, and listing files in git repos
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, normalize, resolve } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { RepoManager } from './repo-manager.js';
import { createGitCommitSignature } from './commit-signer.js';
import type { NostrEvent } from '../../types/nostr.js';
import logger from '../logger.js';
import { sanitizeError, isValidBranchName } from '../../utils/security.js';
import { repoCache, RepoCache } from './repo-cache.js';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface FileContent {
  content: string;
  encoding: string;
  size: number;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}

export interface Diff {
  file: string;
  additions: number;
  deletions: number;
  diff: string;
}

export interface Tag {
  name: string;
  hash: string;
  message?: string;
}

export class FileManager {
  private repoManager: RepoManager;
  private repoRoot: string;

  constructor(repoRoot: string = '/repos') {
    this.repoRoot = repoRoot;
    this.repoManager = new RepoManager(repoRoot);
  }

  /**
   * Create or get a git worktree for a repository
   * More efficient than cloning the entire repo for each operation
   * Security: Validates branch name to prevent path traversal attacks
   */
  private async getWorktree(repoPath: string, branch: string, npub: string, repoName: string): Promise<string> {
    // Security: Validate branch name to prevent path traversal
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
    
    const worktreeRoot = join(this.repoRoot, npub, `${repoName}.worktrees`);
    const worktreePath = join(worktreeRoot, branch);
    
    // Additional security: Ensure resolved path is still within worktreeRoot
    const resolvedPath = resolve(worktreePath).replace(/\\/g, '/');
    const resolvedRoot = resolve(worktreeRoot).replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      throw new Error('Path traversal detected: worktree path outside allowed root');
    }
    const { mkdir, rm } = await import('fs/promises');
    
    // Ensure worktree root exists
    if (!existsSync(worktreeRoot)) {
      await mkdir(worktreeRoot, { recursive: true });
    }
    
    const git = simpleGit(repoPath);
    
    // Check if worktree already exists
    if (existsSync(worktreePath)) {
      // Verify it's a valid worktree
      try {
        const worktreeGit = simpleGit(worktreePath);
        await worktreeGit.status();
        return worktreePath;
      } catch {
        // Invalid worktree, remove it
        await rm(worktreePath, { recursive: true, force: true });
      }
    }
    
    // Create new worktree
    try {
      // Use spawn for worktree add (safer than exec)
      await new Promise<void>((resolve, reject) => {
        const gitProcess = spawn('git', ['worktree', 'add', worktreePath, branch], {
          cwd: repoPath,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stderr = '';
        gitProcess.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        
        gitProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            // If branch doesn't exist, create it first using git branch (works on bare repos)
            if (stderr.includes('fatal: invalid reference') || stderr.includes('fatal: not a valid object name')) {
              // First, try to find a source branch (HEAD, main, or master)
              const findSourceBranch = async (): Promise<string> => {
                try {
                  const branches = await git.branch(['-a']);
                  // Try HEAD first, then main, then master
                  if (branches.all.includes('HEAD') || branches.all.includes('origin/HEAD')) {
                    return 'HEAD';
                  }
                  if (branches.all.includes('main') || branches.all.includes('origin/main')) {
                    return 'main';
                  }
                  if (branches.all.includes('master') || branches.all.includes('origin/master')) {
                    return 'master';
                  }
                  // Use the first available branch
                  const firstBranch = branches.all.find(b => !b.includes('HEAD'));
                  if (firstBranch) {
                    return firstBranch.replace(/^origin\//, '');
                  }
                  throw new Error('No source branch found');
                } catch {
                  // Default to HEAD
                  return 'HEAD';
                }
              };
              
              findSourceBranch().then((sourceBranch) => {
                // Create branch using git branch command (works on bare repos)
                return new Promise<void>((resolveBranch, rejectBranch) => {
                  const branchProcess = spawn('git', ['branch', branch, sourceBranch], {
                    cwd: repoPath,
                    stdio: ['ignore', 'pipe', 'pipe']
                  });
                  
                  let branchStderr = '';
                  branchProcess.stderr.on('data', (chunk: Buffer) => {
                    branchStderr += chunk.toString();
                  });
                  
                  branchProcess.on('close', (branchCode) => {
                    if (branchCode === 0) {
                      resolveBranch();
                    } else {
                      rejectBranch(new Error(`Failed to create branch: ${branchStderr}`));
                    }
                  });
                  
                  branchProcess.on('error', rejectBranch);
                });
              }).then(() => {
                // Retry worktree add after creating the branch
                return new Promise<void>((resolve2, reject2) => {
                  const gitProcess2 = spawn('git', ['worktree', 'add', worktreePath, branch], {
                    cwd: repoPath,
                    stdio: ['ignore', 'pipe', 'pipe']
                  });
                  
                  let retryStderr = '';
                  gitProcess2.stderr.on('data', (chunk: Buffer) => {
                    retryStderr += chunk.toString();
                  });
                  
                  gitProcess2.on('close', (code2) => {
                    if (code2 === 0) {
                      resolve2();
                    } else {
                      reject2(new Error(`Failed to create worktree after creating branch: ${retryStderr}`));
                    }
                  });
                  
                  gitProcess2.on('error', reject2);
                });
              }).then(resolve).catch(reject);
            } else {
              reject(new Error(`Failed to create worktree: ${stderr}`));
            }
          }
        });
        
        gitProcess.on('error', reject);
      });
      
      return worktreePath;
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      logger.error({ error: sanitizedError, repoPath, branch }, 'Failed to create worktree');
      throw new Error(`Failed to create worktree: ${sanitizedError}`);
    }
  }

  /**
   * Remove a worktree
   */
  private async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      // Use spawn for worktree remove (safer than exec)
      await new Promise<void>((resolve, reject) => {
        const gitProcess = spawn('git', ['worktree', 'remove', worktreePath], {
          cwd: repoPath,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        gitProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            // If worktree remove fails, try force remove
            const gitProcess2 = spawn('git', ['worktree', 'remove', '--force', worktreePath], {
              cwd: repoPath,
              stdio: ['ignore', 'pipe', 'pipe']
            });
            
            gitProcess2.on('close', (code2) => {
              if (code2 === 0) {
                resolve();
              } else {
                // Last resort: just delete the directory
                import('fs/promises').then(({ rm }) => {
                  return rm(worktreePath, { recursive: true, force: true });
                }).then(() => resolve()).catch(reject);
              }
            });
            
            gitProcess2.on('error', reject);
          }
        });
        
        gitProcess.on('error', reject);
      });
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      logger.warn({ error: sanitizedError, repoPath, worktreePath }, 'Failed to remove worktree cleanly');
      // Try to remove directory directly as fallback
      try {
        const { rm } = await import('fs/promises');
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get the full path to a repository
   */
  private getRepoPath(npub: string, repoName: string): string {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    // Security: Ensure the resolved path is within repoRoot to prevent path traversal
    // Normalize paths to handle Windows/Unix differences
    const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(this.repoRoot).replace(/\\/g, '/');
    // Must be a subdirectory of repoRoot, not equal to it
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      throw new Error('Path traversal detected: repository path outside allowed root');
    }
    return repoPath;
  }

  /**
   * Validate and sanitize file path to prevent path traversal attacks
   */
  private validateFilePath(filePath: string): { valid: boolean; error?: string; normalized?: string } {
    if (!filePath || typeof filePath !== 'string') {
      return { valid: false, error: 'File path must be a non-empty string' };
    }

    // Normalize the path (resolves .. and .)
    const normalized = normalize(filePath);
    
    // Check for path traversal attempts
    if (normalized.includes('..')) {
      return { valid: false, error: 'Path traversal detected (..)' };
    }

    // Check for absolute paths
    if (normalized.startsWith('/')) {
      return { valid: false, error: 'Absolute paths are not allowed' };
    }

    // Check for null bytes
    if (normalized.includes('\0')) {
      return { valid: false, error: 'Null bytes are not allowed in paths' };
    }

    // Check for control characters
    if (/[\x00-\x1f\x7f]/.test(normalized)) {
      return { valid: false, error: 'Control characters are not allowed in paths' };
    }

    // Limit path length (reasonable limit)
    if (normalized.length > 4096) {
      return { valid: false, error: 'Path is too long (max 4096 characters)' };
    }

    return { valid: true, normalized };
  }

  /**
   * Validate repository name to prevent injection attacks
   */
  private validateRepoName(repoName: string): { valid: boolean; error?: string } {
    if (!repoName || typeof repoName !== 'string') {
      return { valid: false, error: 'Repository name must be a non-empty string' };
    }

    // Check length
    if (repoName.length > 100) {
      return { valid: false, error: 'Repository name is too long (max 100 characters)' };
    }

    // Check for invalid characters (alphanumeric, hyphens, underscores, dots)
    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
      return { valid: false, error: 'Repository name contains invalid characters' };
    }

    // Check for path traversal
    if (repoName.includes('..') || repoName.includes('/') || repoName.includes('\\')) {
      return { valid: false, error: 'Repository name contains invalid path characters' };
    }

    return { valid: true };
  }

  /**
   * Validate npub format
   */
  private validateNpub(npub: string): { valid: boolean; error?: string } {
    if (!npub || typeof npub !== 'string') {
      return { valid: false, error: 'npub must be a non-empty string' };
    }

    // Basic npub format check (starts with npub, base58 encoded)
    if (!npub.startsWith('npub1') || npub.length < 10 || npub.length > 100) {
      return { valid: false, error: 'Invalid npub format' };
    }

    return { valid: true };
  }

  /**
   * Check if repository exists (with caching)
   */
  repoExists(npub: string, repoName: string): boolean {
    // Validate inputs
    const npubValidation = this.validateNpub(npub);
    if (!npubValidation.valid) {
      return false;
    }
    const repoValidation = this.validateRepoName(repoName);
    if (!repoValidation.valid) {
      return false;
    }

    // Check cache first
    const cacheKey = RepoCache.repoExistsKey(npub, repoName);
    const cached = repoCache.get<boolean>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const repoPath = this.getRepoPath(npub, repoName);
    const exists = this.repoManager.repoExists(repoPath);
    
    // Cache the result (cache for 1 minute)
    repoCache.set(cacheKey, exists, 60 * 1000);
    
    return exists;
  }

  /**
   * List files and directories in a repository at a given path
   * Uses caching to reduce redundant git operations
   */
  async listFiles(npub: string, repoName: string, ref: string = 'HEAD', path: string = ''): Promise<FileEntry[]> {
    // Validate inputs
    const npubValidation = this.validateNpub(npub);
    if (!npubValidation.valid) {
      throw new Error(`Invalid npub: ${npubValidation.error}`);
    }
    const repoValidation = this.validateRepoName(repoName);
    if (!repoValidation.valid) {
      throw new Error(`Invalid repository name: ${repoValidation.error}`);
    }
    
    const pathValidation = this.validateFilePath(path);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    // Check cache first (cache for 2 minutes)
    const cacheKey = RepoCache.fileListKey(npub, repoName, ref, path);
    const cached = repoCache.get<FileEntry[]>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const git: SimpleGit = simpleGit(repoPath);
    
    try {
      // Get the tree for the specified path
      const tree = await git.raw(['ls-tree', '-l', ref, path || '.']);
      
      if (!tree) {
        const emptyResult: FileEntry[] = [];
        // Cache empty result for shorter time (30 seconds)
        repoCache.set(cacheKey, emptyResult, 30 * 1000);
        return emptyResult;
      }

      const entries: FileEntry[] = [];
      const lines = tree.trim().split('\n').filter(line => line.length > 0);

      for (const line of lines) {
        // Format: <mode> <type> <object> <size>\t<file>
        const match = line.match(/^(\d+)\s+(\w+)\s+(\w+)\s+(\d+|-)\s+(.+)$/);
        if (match) {
          const [, , type, , size, name] = match;
          const fullPath = path ? join(path, name) : name;
          
          entries.push({
            name,
            path: fullPath,
            type: type === 'tree' ? 'directory' : 'file',
            size: size !== '-' ? parseInt(size, 10) : undefined
          });
        }
      }

      const sortedEntries = entries.sort((a, b) => {
        // Directories first, then files, both alphabetically
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      // Cache the result (cache for 2 minutes)
      repoCache.set(cacheKey, sortedEntries, 2 * 60 * 1000);
      
      return sortedEntries;
    } catch (error) {
      logger.error({ error, repoPath, ref }, 'Error listing files');
      throw new Error(`Failed to list files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get file content from a repository
   */
  async getFileContent(npub: string, repoName: string, filePath: string, ref: string = 'HEAD'): Promise<FileContent> {
    // Validate inputs
    const npubValidation = this.validateNpub(npub);
    if (!npubValidation.valid) {
      throw new Error(`Invalid npub: ${npubValidation.error}`);
    }
    const repoValidation = this.validateRepoName(repoName);
    if (!repoValidation.valid) {
      throw new Error(`Invalid repository name: ${repoValidation.error}`);
    }
    
    const pathValidation = this.validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      // Get file content using git show
      const content = await git.show([`${ref}:${filePath}`]);
      
      // Try to determine encoding (assume UTF-8 for text files)
      const encoding = 'utf-8';
      const size = Buffer.byteLength(content, encoding);

      return {
        content,
        encoding,
        size
      };
    } catch (error) {
      logger.error({ error, repoPath, filePath, ref }, 'Error reading file');
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Write file and commit changes
   * @param signingOptions - Optional commit signing options:
   *   - useNIP07: Use NIP-07 browser extension (client-side, secure - keys never leave browser)
   *   - nip98Event: Use NIP-98 auth event as signature (server-side, for git operations)
   *   - nsecKey: Use direct nsec/hex key (server-side ONLY, via environment variables - NOT for client requests)
   */
  async writeFile(
    npub: string,
    repoName: string,
    filePath: string,
    content: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main',
    signingOptions?: {
      useNIP07?: boolean;
      nip98Event?: NostrEvent;
      nsecKey?: string;
    }
  ): Promise<void> {
    // Validate inputs
    const npubValidation = this.validateNpub(npub);
    if (!npubValidation.valid) {
      throw new Error(`Invalid npub: ${npubValidation.error}`);
    }
    const repoValidation = this.validateRepoName(repoName);
    if (!repoValidation.valid) {
      throw new Error(`Invalid repository name: ${repoValidation.error}`);
    }
    
    const pathValidation = this.validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    // Security: Validate branch name to prevent path traversal
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    // Validate content size (prevent extremely large files)
    const maxFileSize = 500 * 1024 * 1024; // 500 MB per file (allows for images and demo videos)
    if (Buffer.byteLength(content, 'utf-8') > maxFileSize) {
      throw new Error(`File is too large (max ${maxFileSize / 1024 / 1024} MB)`);
    }

    // Validate commit message
    if (!commitMessage || typeof commitMessage !== 'string' || commitMessage.trim().length === 0) {
      throw new Error('Commit message is required');
    }
    if (commitMessage.length > 1000) {
      throw new Error('Commit message is too long (max 1000 characters)');
    }

    // Validate author info
    if (!authorName || typeof authorName !== 'string' || authorName.trim().length === 0) {
      throw new Error('Author name is required');
    }
    if (!authorEmail || typeof authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
      throw new Error('Valid author email is required');
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    try {
      // Check repository size before writing
      const repoSizeCheck = await this.repoManager.checkRepoSizeLimit(repoPath);
      if (!repoSizeCheck.withinLimit) {
        throw new Error(repoSizeCheck.error || 'Repository size limit exceeded');
      }

      // Use git worktree instead of cloning (much more efficient)
      const workDir = await this.getWorktree(repoPath, branch, npub, repoName);
      const workGit: SimpleGit = simpleGit(workDir);

      // Write the file (use validated path)
      const validatedPath = pathValidation.normalized || filePath;
      const fullFilePath = join(workDir, validatedPath);
      const fileDir = dirname(fullFilePath);
      
      // Additional security: ensure the resolved path is still within workDir
      // Use trailing slash to ensure directory boundary (prevents sibling directory attacks)
      const resolvedPath = resolve(fullFilePath).replace(/\\/g, '/');
      const resolvedWorkDir = resolve(workDir).replace(/\\/g, '/');
      if (!resolvedPath.startsWith(resolvedWorkDir + '/') && resolvedPath !== resolvedWorkDir) {
        throw new Error('Path validation failed: resolved path outside work directory');
      }
      
      // Ensure directory exists
      if (!existsSync(fileDir)) {
        const { mkdir } = await import('fs/promises');
        await mkdir(fileDir, { recursive: true });
      }

      const { writeFile: writeFileFs } = await import('fs/promises');
      await writeFileFs(fullFilePath, content, 'utf-8');

      // Stage the file (use validated path)
      await workGit.add(validatedPath);

      // Sign commit if signing options are provided
      let finalCommitMessage = commitMessage;
      if (signingOptions && (signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
        try {
          const { signedMessage } = await createGitCommitSignature(
            commitMessage,
            authorName,
            authorEmail,
            signingOptions
          );
          finalCommitMessage = signedMessage;
        } catch (err) {
          // Security: Sanitize error messages (never log private keys)
          const sanitizedErr = sanitizeError(err);
          logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
          // Continue without signature if signing fails
        }
      }

      // Commit
      await workGit.commit(finalCommitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo (worktree is already connected)
      await workGit.push(['origin', branch]);

      // Clean up worktree (but keep it for potential reuse)
      // Note: We could keep worktrees for better performance, but clean up for now
      await this.removeWorktree(repoPath, workDir);
    } catch (error) {
      logger.error({ error, repoPath, filePath, npub }, 'Error writing file');
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get list of branches (with caching)
   */
  async getBranches(npub: string, repoName: string): Promise<string[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    // Check cache first
    const cacheKey = RepoCache.branchesKey(npub, repoName);
    const cached = repoCache.get<string[]>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const branches = await git.branch(['-r']);
      const branchList = branches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'));
      
      // Cache the result (cache for 2 minutes)
      repoCache.set(cacheKey, branchList, 2 * 60 * 1000);
      
      return branchList;
    } catch (error) {
      logger.error({ error, repoPath }, 'Error getting branches');
      const defaultBranches = ['main', 'master'];
      // Cache default branches for shorter time (30 seconds)
      repoCache.set(cacheKey, defaultBranches, 30 * 1000);
      return defaultBranches;
    }
  }

  /**
   * Create a new file
   * @param signingOptions - Optional commit signing options (see writeFile)
   */
  async createFile(
    npub: string,
    repoName: string,
    filePath: string,
    content: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main',
    signingOptions?: {
      useNIP07?: boolean;
      nip98Event?: NostrEvent;
      nsecKey?: string;
    }
  ): Promise<void> {
    // Reuse writeFile logic - it will create the file if it doesn't exist
    return this.writeFile(npub, repoName, filePath, content, commitMessage, authorName, authorEmail, branch, signingOptions);
  }

  /**
   * Delete a file
   * @param signingOptions - Optional commit signing options (see writeFile)
   */
  async deleteFile(
    npub: string,
    repoName: string,
    filePath: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main',
    signingOptions?: {
      useNIP07?: boolean;
      nip98Event?: NostrEvent;
      nsecKey?: string;
    }
  ): Promise<void> {
    // Validate inputs
    const npubValidation = this.validateNpub(npub);
    if (!npubValidation.valid) {
      throw new Error(`Invalid npub: ${npubValidation.error}`);
    }
    const repoValidation = this.validateRepoName(repoName);
    if (!repoValidation.valid) {
      throw new Error(`Invalid repository name: ${repoValidation.error}`);
    }
    
    const pathValidation = this.validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    // Security: Validate branch name to prevent path traversal
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    // Validate commit message
    if (!commitMessage || typeof commitMessage !== 'string' || commitMessage.trim().length === 0) {
      throw new Error('Commit message is required');
    }

    // Validate author info
    if (!authorName || typeof authorName !== 'string' || authorName.trim().length === 0) {
      throw new Error('Author name is required');
    }
    if (!authorEmail || typeof authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
      throw new Error('Valid author email is required');
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    try {
      // Use git worktree instead of cloning (much more efficient)
      const workDir = await this.getWorktree(repoPath, branch, npub, repoName);
      const workGit: SimpleGit = simpleGit(workDir);

      // Remove the file (use validated path)
      const validatedPath = pathValidation.normalized || filePath;
      const fullFilePath = join(workDir, validatedPath);
      
      // Additional security: ensure the resolved path is still within workDir
      // Use trailing slash to ensure directory boundary (prevents sibling directory attacks)
      const resolvedPath = resolve(fullFilePath).replace(/\\/g, '/');
      const resolvedWorkDir = resolve(workDir).replace(/\\/g, '/');
      if (!resolvedPath.startsWith(resolvedWorkDir + '/') && resolvedPath !== resolvedWorkDir) {
        throw new Error('Path validation failed: resolved path outside work directory');
      }
      
      if (existsSync(fullFilePath)) {
        const { unlink } = await import('fs/promises');
        await unlink(fullFilePath);
      }

      // Stage the deletion (use validated path)
      await workGit.rm([validatedPath]);

      // Sign commit if signing options are provided
      let finalCommitMessage = commitMessage;
      if (signingOptions && (signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
        try {
          const { signedMessage } = await createGitCommitSignature(
            commitMessage,
            authorName,
            authorEmail,
            signingOptions
          );
          finalCommitMessage = signedMessage;
        } catch (err) {
          // Security: Sanitize error messages (never log private keys)
          const sanitizedErr = sanitizeError(err);
          logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
          // Continue without signature if signing fails
        }
      }

      // Commit
      await workGit.commit(finalCommitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo (worktree is already connected)
      await workGit.push(['origin', branch]);

      // Clean up worktree
      await this.removeWorktree(repoPath, workDir);
    } catch (error) {
      logger.error({ error, repoPath, filePath, npub }, 'Error deleting file');
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create a new branch
   */
  async createBranch(
    npub: string,
    repoName: string,
    branchName: string,
    fromBranch: string = 'main'
  ): Promise<void> {
    // Security: Validate branch names to prevent path traversal
    if (!isValidBranchName(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}`);
    }
    if (!isValidBranchName(fromBranch)) {
      throw new Error(`Invalid source branch name: ${fromBranch}`);
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    try {
      // Use git worktree instead of cloning (much more efficient)
      const workDir = await this.getWorktree(repoPath, fromBranch, npub, repoName);
      const workGit: SimpleGit = simpleGit(workDir);

      // Create and checkout new branch
      await workGit.checkout(['-b', branchName]);

      // Push new branch
      await workGit.push(['origin', branchName]);

      // Clean up worktree
      await this.removeWorktree(repoPath, workDir);
    } catch (error) {
      logger.error({ error, repoPath, branchName, npub }, 'Error creating branch');
      throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get commit history
   */
  async getCommitHistory(
    npub: string,
    repoName: string,
    branch: string = 'main',
    limit: number = 50,
    path?: string
  ): Promise<Commit[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const logOptions: {
        maxCount: number;
        from: string;
        file?: string;
      } = {
        maxCount: limit,
        from: branch
      };

      if (path) {
        logOptions.file = path;
      }

      const log = await git.log(logOptions);
      
      return log.all.map(commit => ({
        hash: commit.hash,
        message: commit.message,
        author: `${commit.author_name} <${commit.author_email}>`,
        date: commit.date,
        files: commit.diff?.files?.map((f: { file: string }) => f.file) || []
      }));
    } catch (error) {
      logger.error({ error, repoPath, branch, limit }, 'Error getting commit history');
      throw new Error(`Failed to get commit history: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get diff between two commits or for a file
   */
  async getDiff(
    npub: string,
    repoName: string,
    fromRef: string,
    toRef: string = 'HEAD',
    filePath?: string
  ): Promise<Diff[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const diffOptions: string[] = [fromRef, toRef];
      if (filePath) {
        diffOptions.push('--', filePath);
      }

      const diff = await git.diff(diffOptions);
      const stats = await git.diffSummary(diffOptions);

      // Parse diff output
      const files: Diff[] = [];
      const diffLines = diff.split('\n');
      let currentFile = '';
      let currentDiff = '';
      let inFileHeader = false;

      for (const line of diffLines) {
        if (line.startsWith('diff --git')) {
          if (currentFile) {
            files.push({
              file: currentFile,
              additions: 0,
              deletions: 0,
              diff: currentDiff
            });
          }
          const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
          if (match) {
            currentFile = match[2];
            currentDiff = line + '\n';
            inFileHeader = true;
          }
        } else {
          currentDiff += line + '\n';
          if (line.startsWith('@@')) {
            inFileHeader = false;
          }
          if (!inFileHeader && (line.startsWith('+') || line.startsWith('-'))) {
            // Count additions/deletions
          }
        }
      }

      if (currentFile) {
        files.push({
          file: currentFile,
          additions: 0,
          deletions: 0,
          diff: currentDiff
        });
      }

      // Add stats from diffSummary
      if (stats.files && files.length > 0) {
        for (const statFile of stats.files) {
          const file = files.find(f => f.file === statFile.file);
          if (file && 'insertions' in statFile && 'deletions' in statFile) {
            file.additions = statFile.insertions;
            file.deletions = statFile.deletions;
          }
        }
      }

      return files;
    } catch (error) {
      logger.error({ error, repoPath, fromRef, toRef }, 'Error getting diff');
      throw new Error(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create a tag
   */
  async createTag(
    npub: string,
    repoName: string,
    tagName: string,
    ref: string = 'HEAD',
    message?: string,
    authorName?: string,
    authorEmail?: string
  ): Promise<void> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      if (message) {
        // Create annotated tag
        await git.addTag(tagName);
        // Note: simple-git addTag doesn't support message directly, use raw command
        if (ref !== 'HEAD') {
          await git.raw(['tag', '-a', tagName, '-m', message, ref]);
        } else {
          await git.raw(['tag', '-a', tagName, '-m', message]);
        }
      } else {
        // Create lightweight tag
        if (ref !== 'HEAD') {
          await git.raw(['tag', tagName, ref]);
        } else {
          await git.addTag(tagName);
        }
      }
    } catch (error) {
      logger.error({ error, repoPath, tagName, ref, message }, 'Error creating tag');
      throw new Error(`Failed to create tag: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get list of tags
   */
  async getTags(npub: string, repoName: string): Promise<Tag[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const tags = await git.tags();
      const tagList: Tag[] = [];

      for (const tagName of tags.all) {
        try {
          // Try to get tag message
          const tagInfo = await git.raw(['cat-file', '-p', tagName]);
          const messageMatch = tagInfo.match(/^(.+)$/m);
          const hash = await git.raw(['rev-parse', tagName]);
          
          tagList.push({
            name: tagName,
            hash: hash.trim(),
            message: messageMatch ? messageMatch[1] : undefined
          });
        } catch {
          // Lightweight tag
          const hash = await git.raw(['rev-parse', tagName]);
          tagList.push({
            name: tagName,
            hash: hash.trim()
          });
        }
      }

      return tagList;
    } catch (error) {
      logger.error({ error, repoPath }, 'Error getting tags');
      return [];
    }
  }
}
