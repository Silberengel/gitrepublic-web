/**
 * File manager for git repositories
 * Handles reading, writing, and listing files in git repos
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { readdir } from 'fs/promises';
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
  async getWorktree(repoPath: string, branch: string, npub: string, repoName: string): Promise<string> {
    // Security: Validate branch name to prevent path traversal
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
    
    const worktreeRoot = join(this.repoRoot, npub, `${repoName}.worktrees`);
    // Use resolve to ensure we have an absolute path (important for git worktree add)
    const worktreePath = resolve(join(worktreeRoot, branch));
    const resolvedWorktreeRoot = resolve(worktreeRoot);
    
    // Additional security: Ensure resolved path is still within worktreeRoot
    const resolvedPath = worktreePath.replace(/\\/g, '/');
    const resolvedRoot = resolvedWorktreeRoot.replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      throw new Error('Path traversal detected: worktree path outside allowed root');
    }
    const { mkdir, rm } = await import('fs/promises');
    
    // Ensure worktree root exists (use resolved path)
    if (!existsSync(resolvedWorktreeRoot)) {
      await mkdir(resolvedWorktreeRoot, { recursive: true });
    }
    
    const git = simpleGit(repoPath);
    
    // Check for existing worktrees for this branch and clean them up if they're in the wrong location
    try {
      const worktreeList = await git.raw(['worktree', 'list', '--porcelain']);
      const lines = worktreeList.split('\n');
      let currentWorktreePath: string | null = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('worktree ')) {
          currentWorktreePath = line.substring(9).trim();
        } else if (line.startsWith('branch ') && line.includes(`refs/heads/${branch}`)) {
          // Found a worktree for this branch
          if (currentWorktreePath && currentWorktreePath !== worktreePath) {
            // Worktree exists but in wrong location - remove it
            logger.warn({ oldPath: currentWorktreePath, newPath: worktreePath, branch }, 'Removing worktree from incorrect location');
            try {
              await git.raw(['worktree', 'remove', currentWorktreePath, '--force']);
            } catch (err) {
              // If git worktree remove fails, try to remove the directory manually
              logger.warn({ error: err, path: currentWorktreePath }, 'Failed to remove worktree via git, will try manual removal');
              try {
                await rm(currentWorktreePath, { recursive: true, force: true });
              } catch (rmErr) {
                logger.error({ error: rmErr, path: currentWorktreePath }, 'Failed to manually remove worktree directory');
              }
            }
          }
          break;
        }
      }
    } catch (err) {
      // If worktree list fails, continue - might be no worktrees yet
      logger.debug({ error: err }, 'Could not list worktrees (this is okay if no worktrees exist)');
    }
    
    // Check if worktree already exists at the correct location
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
      
      // Verify the worktree directory was actually created (after the promise resolves)
      if (!existsSync(worktreePath)) {
        throw new Error(`Worktree directory was not created: ${worktreePath}`);
      }
      
      // Verify it's a valid git repository
      const worktreeGit = simpleGit(worktreePath);
      try {
        await worktreeGit.status();
      } catch (err) {
        throw new Error(`Created worktree directory is not a valid git repository: ${worktreePath}`);
      }
      
      return worktreePath;
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      logger.error({ error: sanitizedError, repoPath, branch, worktreePath }, 'Failed to create worktree');
      throw new Error(`Failed to create worktree: ${sanitizedError}`);
    }
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
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
  getRepoPath(npub: string, repoName: string): string {
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
    // Allow empty string for root directory
    if (filePath === '') {
      return { valid: true, normalized: '' };
    }
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
      // Use raw() for better error handling and to catch stderr
      let content: string;
      try {
        content = await git.raw(['show', `${ref}:${filePath}`]);
      } catch (gitError: any) {
        // simple-git might throw errors in different formats
        // Check stderr if available
        const stderr = gitError?.stderr || gitError?.message || String(gitError);
        const stderrLower = stderr.toLowerCase();
        
        logger.debug({ gitError, repoPath, filePath, ref, stderr }, 'git.raw() error details');
        
        // Check if it's a "not found" type error
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
        
        // Re-throw with more context
        throw new Error(`Git command failed: ${stderr}`);
      }
      
      // Check if content is undefined or null (indicates error)
      if (content === undefined || content === null) {
        throw new Error(`File not found: ${filePath} at ref ${ref}`);
      }
      
      // Try to determine encoding (assume UTF-8 for text files)
      const encoding = 'utf-8';
      const size = Buffer.byteLength(content, encoding);

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
      
      logger.error({ error, repoPath, filePath, ref, errorMessage, errorString }, 'Error reading file');
      
      // Check if it's a "not found" type error (check both errorMessage and errorString)
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
      
      throw new Error(`Failed to read file: ${errorMessage}`);
    }
  }

  /**
   * Write file and commit changes
   * @param signingOptions - Optional commit signing options:
   *   - commitSignatureEvent: Pre-signed commit signature event from client (NIP-07, recommended)
   *   - useNIP07: Use NIP-07 browser extension (DEPRECATED: use commitSignatureEvent instead)
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
      commitSignatureEvent?: NostrEvent;
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
      if (signingOptions && (signingOptions.commitSignatureEvent || signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
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
      const commitResult = await workGit.commit(finalCommitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      }) as string | { commit: string };

      // Get commit hash from result
      let commitHash: string;
      if (typeof commitResult === 'string') {
        commitHash = commitResult.trim();
      } else if (commitResult && typeof commitResult === 'object' && 'commit' in commitResult) {
        commitHash = String(commitResult.commit);
      } else {
        // Fallback: get latest commit hash
        commitHash = await workGit.revparse(['HEAD']);
      }

      // Save commit signature event to nostr folder if signing was used
      if (signingOptions && (signingOptions.commitSignatureEvent || signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
        try {
          // Get the signature event that was used (already created above)
          let signatureEvent: NostrEvent;
          if (signingOptions.commitSignatureEvent) {
            signatureEvent = signingOptions.commitSignatureEvent;
          } else {
            // Re-create it to get the event object
            const { signedMessage: _, signatureEvent: event } = await createGitCommitSignature(
              commitMessage,
              authorName,
              authorEmail,
              signingOptions
            );
            signatureEvent = event;
          }
          
          // Update signature event with actual commit hash
          const { updateCommitSignatureWithHash } = await import('./commit-signer.js');
          const updatedEvent = updateCommitSignatureWithHash(signatureEvent, commitHash);
          
          // Save to nostr/commit-signatures.jsonl (use workDir since we have it)
          await this.saveCommitSignatureEventToWorktree(workDir, updatedEvent);
          
          // Check if repo is private - only publish to relays if public
          const isPrivate = await this.isRepoPrivate(npub, repoName);
          if (!isPrivate) {
            // Public repo: publish commit signature event to relays
            try {
              const { NostrClient } = await import('../nostr/nostr-client.js');
              const { DEFAULT_NOSTR_RELAYS } = await import('../../config.js');
              const { getUserRelays } = await import('../nostr/user-relays.js');
              const { combineRelays } = await import('../../config.js');
              
              // Get user's preferred relays (outbox/inbox from kind 10002)
              const { nip19 } = await import('nostr-tools');
              const { requireNpubHex } = await import('../../utils/npub-utils.js');
              const userPubkeyHex = requireNpubHex(npub);
              
              const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
              const { inbox, outbox } = await getUserRelays(userPubkeyHex, nostrClient);
              
              // Use user's outbox relays if available, otherwise inbox, otherwise defaults
              const userRelays = outbox.length > 0 
                ? combineRelays(outbox, DEFAULT_NOSTR_RELAYS)
                : inbox.length > 0
                ? combineRelays(inbox, DEFAULT_NOSTR_RELAYS)
                : DEFAULT_NOSTR_RELAYS;
              
              // Publish to relays (non-blocking - don't fail if publishing fails)
              const publishResult = await nostrClient.publishEvent(updatedEvent, userRelays);
              if (publishResult.success.length > 0) {
                logger.debug({ 
                  eventId: updatedEvent.id, 
                  commitHash,
                  relays: publishResult.success 
                }, 'Published commit signature event to relays');
              }
              if (publishResult.failed.length > 0) {
                logger.warn({ 
                  eventId: updatedEvent.id,
                  failed: publishResult.failed 
                }, 'Some relays failed to publish commit signature event');
              }
            } catch (publishErr) {
              // Log but don't fail - publishing is nice-to-have, saving to repo is the important part
              const sanitizedErr = sanitizeError(publishErr);
              logger.debug({ error: sanitizedErr, repoPath, filePath }, 'Failed to publish commit signature event to relays');
            }
          } else {
            // Private repo: only save to repo, don't publish to relays
            logger.debug({ repoPath, filePath }, 'Private repo - commit signature event saved to repo only (not published to relays)');
          }
        } catch (err) {
          // Log but don't fail - saving event is nice-to-have
          const sanitizedErr = sanitizeError(err);
          logger.debug({ error: sanitizedErr, repoPath, filePath }, 'Failed to save commit signature event');
        }
      }

      // Note: No push needed - worktrees of bare repos share the same object database,
      // so the commit is already in the bare repository. We don't push to remote origin
      // to avoid requiring remote authentication and to keep changes local-only.t

      // Clean up worktree (but keep it for potential reuse)
      // Note: We could keep worktrees for better performance, but clean up for now
      await this.removeWorktree(repoPath, workDir);
    } catch (error) {
      logger.error({ error, repoPath, filePath, npub }, 'Error writing file');
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save commit signature event to nostr/commit-signatures.jsonl in a worktree
   */
  private async saveCommitSignatureEventToWorktree(worktreePath: string, event: NostrEvent): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      
      // Create nostr directory in worktree
      const nostrDir = join(worktreePath, 'nostr');
      await mkdir(nostrDir, { recursive: true });
      
      // Append to commit-signatures.jsonl
      const jsonlFile = join(nostrDir, 'commit-signatures.jsonl');
      const eventLine = JSON.stringify(event) + '\n';
      await writeFile(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
    } catch (err) {
      logger.debug({ error: err, worktreePath }, 'Failed to save commit signature event to nostr folder');
      // Don't throw - this is a nice-to-have feature
    }
  }

  /**
   * Save a repo event (announcement or transfer) to nostr/repo-events.jsonl
   * This provides a standard location for all repo-related Nostr events for easy analysis
   */
  async saveRepoEventToWorktree(
    worktreePath: string,
    event: NostrEvent,
    eventType: 'announcement' | 'transfer'
  ): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      
      // Create nostr directory in worktree
      const nostrDir = join(worktreePath, 'nostr');
      await mkdir(nostrDir, { recursive: true });
      
      // Append to repo-events.jsonl with event type metadata
      const jsonlFile = join(nostrDir, 'repo-events.jsonl');
      const eventLine = JSON.stringify({
        type: eventType,
        timestamp: event.created_at,
        event
      }) + '\n';
      await writeFile(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
    } catch (err) {
      logger.debug({ error: err, worktreePath, eventType }, 'Failed to save repo event to nostr/repo-events.jsonl');
      // Don't throw - this is a nice-to-have feature
    }
  }

  /**
   * Check if a repository is private by fetching its announcement event
   */
  private async isRepoPrivate(npub: string, repoName: string): Promise<boolean> {
    try {
      const { requireNpubHex } = await import('../../utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHex(npub);
      
      // Fetch the repository announcement
      const { NostrClient } = await import('../nostr/nostr-client.js');
      const { DEFAULT_NOSTR_RELAYS } = await import('../../config.js');
      const { KIND } = await import('../../types/nostr.js');
      
      const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repoName],
          limit: 1
        }
      ]);
      
      if (events.length === 0) {
        // No announcement found - assume public (default)
        return false;
      }
      
      const announcement = events[0];
      
      // Check for ["private", "true"] tag
      const privateTag = announcement.tags.find(t => t[0] === 'private' && t[1] === 'true');
      if (privateTag) return true;
      
      // Check for ["private"] tag (just the tag name, no value)
      const privateTagOnly = announcement.tags.find(t => t[0] === 'private' && (!t[1] || t[1] === ''));
      if (privateTagOnly) return true;
      
      // Check for ["t", "private"] tag (topic tag)
      const topicTag = announcement.tags.find(t => t[0] === 't' && t[1] === 'private');
      if (topicTag) return true;
      
      return false;
    } catch (err) {
      // If we can't determine, default to public (safer - allows publishing)
      logger.debug({ error: err, npub, repoName }, 'Failed to check repo privacy, defaulting to public');
      return false;
    }
  }

  /**
   * Get list of branches (with caching)
   */
  /**
   * Get the default branch name for a repository
   * Tries to detect the actual default branch (master, main, etc.)
   */
  async getDefaultBranch(npub: string, repoName: string): Promise<string> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      // Try to get the default branch from symbolic-ref
      // For bare repos, this points to the default branch
      const defaultRef = await git.raw(['symbolic-ref', 'HEAD']);
      if (defaultRef) {
        const match = defaultRef.trim().match(/^refs\/heads\/(.+)$/);
        if (match) {
          return match[1];
        }
      }
    } catch {
      // If symbolic-ref fails, try to get from remote HEAD
      try {
        const remoteHead = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
        if (remoteHead) {
          const match = remoteHead.trim().match(/^refs\/remotes\/origin\/(.+)$/);
          if (match) {
            return match[1];
          }
        }
      } catch {
        // Fall through to branch detection
      }
    }

    // Fallback: get branches and prefer 'main', then 'master', then first branch
    try {
      const branches = await git.branch(['-r']);
      const branchList = branches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'));
      
      if (branchList.length === 0) {
        return 'main'; // Ultimate fallback
      }

      // Prefer 'main', then 'master', then first branch
      if (branchList.includes('main')) return 'main';
      if (branchList.includes('master')) return 'master';
      return branchList[0];
    } catch {
      return 'main'; // Ultimate fallback
    }
  }

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
      // For bare repositories, list local branches (they're stored in refs/heads/)
      // Also check remote branches in case the repo has remotes configured
      const [localBranches, remoteBranches] = await Promise.all([
        git.branch(['-a']).catch(() => ({ all: [] })), // List all branches (local and remote)
        git.branch(['-r']).catch(() => ({ all: [] }))  // Also try remote branches separately
      ]);
      
      // Combine local and remote branches, removing duplicates
      const allBranches = new Set<string>();
      
      // Add local branches (from -a, filter out remotes)
      localBranches.all
        .filter(b => !b.startsWith('remotes/') && !b.includes('HEAD'))
        .forEach(b => allBranches.add(b));
      
      // Add remote branches (remove origin/ prefix)
      remoteBranches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'))
        .forEach(b => allBranches.add(b));
      
      // If no branches found, try listing refs directly (for bare repos)
      if (allBranches.size === 0) {
        try {
          const refs = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
          if (refs) {
            refs.trim().split('\n').forEach(b => {
              if (b && !b.includes('HEAD')) {
                allBranches.add(b);
              }
            });
          }
        } catch {
          // If that fails too, continue with empty set
        }
      }
      
      const branchList = Array.from(allBranches).sort();
      
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
      commitSignatureEvent?: NostrEvent;
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
      if (signingOptions && (signingOptions.commitSignatureEvent || signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
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

      // Note: No push needed - worktrees of bare repos share the same object database,
      // so the commit is already in the bare repository. We don't push to remote origin
      // to avoid requiring remote authentication and to keep changes local-only.

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
      const git: SimpleGit = simpleGit(repoPath);
      
      // Check if repo has any branches
      let hasBranches = false;
      try {
        const branches = await git.branch(['-a']);
        const branchList = branches.all
          .map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, ''))
          .filter(b => !b.includes('HEAD') && !b.startsWith('*'));
        hasBranches = branchList.length > 0;
      } catch {
        // If branch listing fails, assume no branches exist
        hasBranches = false;
      }

      // If no branches exist, create an orphan branch (branch with no parent)
      if (!hasBranches) {
        // Create worktree for the new branch directly (orphan branch)
        const worktreeRoot = join(this.repoRoot, npub, `${repoName}.worktrees`);
        const worktreePath = resolve(join(worktreeRoot, branchName));
        const { mkdir, rm } = await import('fs/promises');
        
        if (!existsSync(worktreeRoot)) {
          await mkdir(worktreeRoot, { recursive: true });
        }
        
        // Remove existing worktree if it exists
        if (existsSync(worktreePath)) {
          try {
            await git.raw(['worktree', 'remove', worktreePath, '--force']);
          } catch {
            await rm(worktreePath, { recursive: true, force: true });
          }
        }
        
        // Create worktree with orphan branch
        await git.raw(['worktree', 'add', worktreePath, '--orphan', branchName]);
        
        // Set the default branch to the new branch in the bare repo
        await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branchName}`]);
        
        // Clean up worktree
        await this.removeWorktree(repoPath, worktreePath);
      } else {
        // Repo has branches - use normal branch creation
        // Use git worktree instead of cloning (much more efficient)
        const workDir = await this.getWorktree(repoPath, fromBranch, npub, repoName);
        const workGit: SimpleGit = simpleGit(workDir);

        // Create and checkout new branch
        await workGit.checkout(['-b', branchName]);

        // Note: No push needed - worktrees of bare repos share the same object database,
        // so the branch is already in the bare repository. We don't push to remote origin
        // to avoid requiring remote authentication and to keep changes local-only.

        // Clean up worktree
        await this.removeWorktree(repoPath, workDir);
      }
    } catch (error) {
      logger.error({ error, repoPath, branchName, npub }, 'Error creating branch');
      throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a branch
   */
  async deleteBranch(
    npub: string,
    repoName: string,
    branchName: string
  ): Promise<void> {
    // Security: Validate branch name to prevent path traversal
    if (!isValidBranchName(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}`);
    }

    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    // Prevent deleting the default branch
    const defaultBranch = await this.getDefaultBranch(npub, repoName);
    if (branchName === defaultBranch) {
      throw new Error(`Cannot delete the default branch (${defaultBranch}). Please switch to a different branch first.`);
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      // Check if branch exists
      const branches = await git.branch(['-a']);
      const branchExists = branches.all.some(b => 
        b === branchName || 
        b === `refs/heads/${branchName}` ||
        b.replace(/^origin\//, '') === branchName
      );

      if (!branchExists) {
        throw new Error(`Branch ${branchName} does not exist`);
      }

      // Delete the branch (use -D to force delete even if not merged)
      // For bare repos, we delete the ref directly
      await git.raw(['branch', '-D', branchName]).catch(async () => {
        // If branch -D fails (might be a remote branch reference), try deleting the ref directly
        try {
          await git.raw(['update-ref', '-d', `refs/heads/${branchName}`]);
        } catch (refError) {
          // If that also fails, the branch might not exist locally
          throw new Error(`Failed to delete branch: ${branchName}`);
        }
      });

      // Invalidate branches cache
      const cacheKey = RepoCache.branchesKey(npub, repoName);
      repoCache.delete(cacheKey);
    } catch (error) {
      logger.error({ error, repoPath, branchName, npub }, 'Error deleting branch');
      throw new Error(`Failed to delete branch: ${error instanceof Error ? error.message : String(error)}`);
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

  /**
   * Get the current owner from the most recent announcement file in the repository
   * Ownership is determined by the most recent announcement file checked into the git repo
   * 
   * @param npub - Repository owner npub (for path construction)
   * @param repoName - The repository name
   * @returns The current owner pubkey from the most recent announcement file, or null if not found
   */
  async getCurrentOwnerFromRepo(npub: string, repoName: string): Promise<string | null> {
    try {
      const { VERIFICATION_FILE_PATH } = await import('../nostr/repo-verification.js');
      
      if (!this.repoExists(npub, repoName)) {
        return null;
      }
      
      const repoPath = this.getRepoPath(npub, repoName);
      const git: SimpleGit = simpleGit(repoPath);
      
      // Get git log for the announcement file, most recent first
      // Use --all to check all branches, --reverse to get chronological order
      const logOutput = await git.raw(['log', '--all', '--format=%H', '--reverse', '--', VERIFICATION_FILE_PATH]);
      const commitHashes = logOutput.trim().split('\n').filter(Boolean);
      
      if (commitHashes.length === 0) {
        return null; // No announcement file in repo
      }
      
      // Get the most recent announcement file content (last commit in the list)
      const mostRecentCommit = commitHashes[commitHashes.length - 1];
      const announcementFile = await this.getFileContent(npub, repoName, VERIFICATION_FILE_PATH, mostRecentCommit);
      
      // Parse the announcement event from the file
      let announcementEvent: any;
      try {
        announcementEvent = JSON.parse(announcementFile.content);
      } catch (parseError) {
        logger.warn({ error: parseError, npub, repoName, commit: mostRecentCommit }, 'Failed to parse announcement file JSON');
        return null;
      }
      
      // Validate the announcement event to prevent fake announcements
      const { validateAnnouncementEvent } = await import('../nostr/repo-verification.js');
      const validation = validateAnnouncementEvent(announcementEvent, repoName);
      
      if (!validation.valid) {
        logger.warn({ 
          error: validation.error, 
          npub, 
          repoName, 
          commit: mostRecentCommit,
          eventId: announcementEvent.id,
          eventPubkey: announcementEvent.pubkey?.substring(0, 16) + '...'
        }, 'Announcement file validation failed - possible fake announcement');
        return null;
      }
      
      // Return the pubkey from the validated announcement
      return announcementEvent.pubkey;
    } catch (error) {
      logger.error({ error, npub, repoName }, 'Error getting current owner from repo');
      return null;
    }
  }
}
