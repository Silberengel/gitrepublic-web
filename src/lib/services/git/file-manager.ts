/**
 * File manager for git repositories
 * Handles reading, writing, and listing files in git repos
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, normalize, resolve } from 'path';
import { existsSync } from 'fs';
import { RepoManager } from './repo-manager.js';
import { createGitCommitSignature } from './commit-signer.js';
import type { NostrEvent } from '../../types/nostr.js';
import logger from '../logger.js';

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
   * Get the full path to a repository
   */
  private getRepoPath(npub: string, repoName: string): string {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    // Security: Ensure the resolved path is within repoRoot to prevent path traversal
    const resolvedPath = resolve(repoPath);
    const resolvedRoot = resolve(this.repoRoot);
    if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
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
   * Check if repository exists
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

    const repoPath = this.getRepoPath(npub, repoName);
    return this.repoManager.repoExists(repoPath);
  }

  /**
   * List files and directories in a repository at a given path
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

    const git: SimpleGit = simpleGit(repoPath);
    
    try {
      // Get the tree for the specified path
      const tree = await git.raw(['ls-tree', '-l', ref, path || '.']);
      
      if (!tree) {
        return [];
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

      return entries.sort((a, b) => {
        // Directories first, then files, both alphabetically
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
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

      // Clone bare repo to a temporary working directory (non-bare)
      const workDir = join(this.repoRoot, npub, `${repoName}.work`);
      const { rm } = await import('fs/promises');
      
      // Remove work directory if it exists to ensure clean state
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }

      // Clone the bare repo to a working directory
      const git: SimpleGit = simpleGit();
      await git.clone(repoPath, workDir);

      // Use the work directory for operations
      const workGit: SimpleGit = simpleGit(workDir);

      // Checkout the branch (or create it)
      try {
        await workGit.checkout([branch]);
      } catch {
        // Branch doesn't exist, create it
        await workGit.checkout(['-b', branch]);
      }

      // Write the file (use validated path)
      const validatedPath = pathValidation.normalized || filePath;
      const fullFilePath = join(workDir, validatedPath);
      const fileDir = dirname(fullFilePath);
      
      // Additional security: ensure the resolved path is still within workDir
      const resolvedPath = resolve(fullFilePath);
      const resolvedWorkDir = resolve(workDir);
      if (!resolvedPath.startsWith(resolvedWorkDir)) {
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
          const sanitizedErr = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : String(err);
          logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
          // Continue without signature if signing fails
        }
      }

      // Commit
      await workGit.commit(finalCommitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo
      await workGit.push(['origin', branch]);

      // Clean up work directory
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      logger.error({ error, repoPath, filePath, npub }, 'Error writing file');
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get list of branches
   */
  async getBranches(npub: string, repoName: string): Promise<string[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const branches = await git.branch(['-r']);
      return branches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'));
    } catch (error) {
      logger.error({ error, repoPath }, 'Error getting branches');
      return ['main', 'master']; // Default branches
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
      const workDir = join(this.repoRoot, npub, `${repoName}.work`);
      const { rm } = await import('fs/promises');
      
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }

      const git: SimpleGit = simpleGit();
      await git.clone(repoPath, workDir);

      const workGit: SimpleGit = simpleGit(workDir);

      try {
        await workGit.checkout([branch]);
      } catch {
        await workGit.checkout(['-b', branch]);
      }

      // Remove the file (use validated path)
      const validatedPath = pathValidation.normalized || filePath;
      const fullFilePath = join(workDir, validatedPath);
      
      // Additional security: ensure the resolved path is still within workDir
      const resolvedPath = resolve(fullFilePath);
      const resolvedWorkDir = resolve(workDir);
      if (!resolvedPath.startsWith(resolvedWorkDir)) {
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
          const sanitizedErr = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : String(err);
          logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
          // Continue without signature if signing fails
        }
      }

      // Commit
      await workGit.commit(finalCommitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo
      await workGit.push(['origin', branch]);

      // Clean up
      await rm(workDir, { recursive: true, force: true });
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
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    try {
      const workDir = join(this.repoRoot, npub, `${repoName}.work`);
      const { rm } = await import('fs/promises');
      
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }

      const git: SimpleGit = simpleGit();
      await git.clone(repoPath, workDir);

      const workGit: SimpleGit = simpleGit(workDir);

      // Checkout source branch
      await workGit.checkout([fromBranch]);

      // Create and checkout new branch
      await workGit.checkout(['-b', branchName]);

      // Push new branch
      await workGit.push(['origin', branchName]);

      // Clean up
      await rm(workDir, { recursive: true, force: true });
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
      const logOptions: any = {
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
        files: commit.diff?.files?.map((f: any) => f.file) || []
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
