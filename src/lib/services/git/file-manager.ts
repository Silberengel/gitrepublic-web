/**
 * File Manager - Refactored to use modular components
 * Main class that delegates to focused modules
 */

import { join, resolve } from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { RepoManager } from './repo-manager.js';
import logger from '$lib/services/logger.js';
import { sanitizeError, isValidBranchName } from '$lib/utils/security.js';
import { repoCache, RepoCache } from './repo-cache.js';

// Import modular operations
import { getOrCreateWorktree, removeWorktree } from './file-manager/worktree-manager.js';
import { validateFilePath, validateRepoName, validateNpub } from './file-manager/path-validator.js';
import { listFiles, getFileContent } from './file-manager/file-operations.js';
import { getBranches, validateBranchName } from './file-manager/branch-operations.js';
import { writeFile, deleteFile } from './file-manager/write-operations.js';
import { getCommitHistory, getDiff } from './file-manager/commit-operations.js';
import { createTag, getTags } from './file-manager/tag-operations.js';

// Types are defined below

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
  date?: number;
}

export class FileManager {
  private repoManager: RepoManager;
  private repoRoot: string;
  private dirExistenceCache: Map<string, { exists: boolean; timestamp: number }> = new Map();
  private readonly DIR_CACHE_TTL = 5 * 60 * 1000;
  private fsPromises: typeof import('fs/promises') | null = null;

  constructor(repoRoot: string = '/repos') {
    this.repoRoot = repoRoot;
    this.repoManager = new RepoManager(repoRoot);
  }

  private async getFsPromises(): Promise<typeof import('fs/promises')> {
    if (!this.fsPromises) {
      this.fsPromises = await import('fs/promises');
    }
    return this.fsPromises;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      const fs = await this.getFsPromises();
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  private sanitizePathForError(path: string): string {
    const resolvedPath = resolve(path).replace(/\\/g, '/');
    const resolvedRoot = resolve(this.repoRoot).replace(/\\/g, '/');
    if (resolvedPath.startsWith(resolvedRoot + '/')) {
      return resolvedPath.slice(resolvedRoot.length + 1);
    }
    return path.split(/[/\\]/).pop() || path;
  }

  private async ensureDirectoryExists(dirPath: string, description: string): Promise<void> {
    const exists = await this.pathExists(dirPath);
    if (exists) return;

    try {
      const { mkdir } = await this.getFsPromises();
      await mkdir(dirPath, { recursive: true });
      logger.debug({ dirPath: this.sanitizePathForError(dirPath) }, `Created ${description}`);
    } catch (err) {
      logger.error({ error: err, dirPath: this.sanitizePathForError(dirPath) }, `Failed to create ${description}`);
      throw new Error(`Failed to create ${description}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getRepoPath(npub: string, repoName: string): string {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(this.repoRoot).replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      throw new Error('Path traversal detected: repository path outside allowed root');
    }
    return repoPath;
  }

  repoExists(npub: string, repoName: string): boolean {
    const npubValidation = validateNpub(npub);
    if (!npubValidation.valid) return false;
    const repoValidation = validateRepoName(repoName);
    if (!repoValidation.valid) return false;

    const cacheKey = RepoCache.repoExistsKey(npub, repoName);
    const cached = repoCache.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    const repoPath = this.getRepoPath(npub, repoName);
    const exists = this.repoManager.repoExists(repoPath);
    repoCache.set(cacheKey, exists, 60 * 1000);
    return exists;
  }

  async getWorktree(repoPath: string, branch: string, npub: string, repoName: string): Promise<string> {
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
    return getOrCreateWorktree({
      repoPath,
      branch,
      npub,
      repoName,
      repoRoot: this.repoRoot
    });
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    return removeWorktree(repoPath, worktreePath);
  }

  async listFiles(npub: string, repoName: string, ref: string = 'HEAD', path: string = ''): Promise<FileEntry[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }
    return listFiles({ npub, repoName, ref, path, repoPath });
  }

  async getFileContent(npub: string, repoName: string, filePath: string, ref: string = 'HEAD'): Promise<FileContent> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }
    return getFileContent({ npub, repoName, filePath, ref, repoPath });
  }

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
      commitSignatureEvent?: any;
      useNIP07?: boolean;
      nip98Event?: any;
      nsecKey?: string;
    }
  ): Promise<void> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    // Check repo size
    const repoSizeCheck = await this.repoManager.checkRepoSizeLimit(repoPath);
    if (!repoSizeCheck.withinLimit) {
      throw new Error(repoSizeCheck.error || 'Repository size limit exceeded');
    }

    const worktreePath = await this.getWorktree(repoPath, branch, npub, repoName);

    // Save commit signature helper
    const saveCommitSignature = async (worktreePath: string, event: any) => {
      await this.saveCommitSignatureEventToWorktree(worktreePath, event);
    };

    // Check if repo is private
    const isRepoPrivate = async (npub: string, repoName: string) => {
      return this.isRepoPrivate(npub, repoName);
    };

    await writeFile({
      npub,
      repoName,
      filePath,
      content,
      commitMessage,
      authorName,
      authorEmail,
      branch,
      repoPath,
      worktreePath,
      signingOptions,
      saveCommitSignature,
      isRepoPrivate
    });

    await this.removeWorktree(repoPath, worktreePath);
  }

  async deleteFile(
    npub: string,
    repoName: string,
    filePath: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main',
    signingOptions?: {
      commitSignatureEvent?: any;
      useNIP07?: boolean;
      nip98Event?: any;
      nsecKey?: string;
    }
  ): Promise<void> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const worktreePath = await this.getWorktree(repoPath, branch, npub, repoName);

    const saveCommitSignature = async (worktreePath: string, event: any) => {
      await this.saveCommitSignatureEventToWorktree(worktreePath, event);
    };

    await deleteFile({
      npub,
      repoName,
      filePath,
      commitMessage,
      authorName,
      authorEmail,
      branch,
      repoPath,
      worktreePath,
      signingOptions,
      saveCommitSignature
    });

    await this.removeWorktree(repoPath, worktreePath);
  }

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
      nip98Event?: any;
      nsecKey?: string;
    }
  ): Promise<void> {
    return this.writeFile(npub, repoName, filePath, content, commitMessage, authorName, authorEmail, branch, signingOptions);
  }

  async getDefaultBranch(npub: string, repoName: string): Promise<string> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      const defaultRef = await git.raw(['symbolic-ref', 'HEAD']);
      if (defaultRef) {
        const match = defaultRef.trim().match(/^refs\/heads\/(.+)$/);
        if (match) return match[1];
      }
    } catch {
      try {
        const remoteHead = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
        if (remoteHead) {
          const match = remoteHead.trim().match(/^refs\/remotes\/origin\/(.+)$/);
          if (match) return match[1];
        }
      } catch {
        // Fall through
      }
    }

    try {
      const branches = await git.branch(['-r']);
      const branchList = branches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'));
      
      if (branchList.length === 0) return 'main';
      if (branchList.includes('main')) return 'main';
      if (branchList.includes('master')) return 'master';
      return branchList[0];
    } catch {
      return 'main';
    }
  }

  async getBranches(npub: string, repoName: string): Promise<string[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }
    return getBranches({
      npub,
      repoName,
      repoPath,
      getDefaultBranch: (npub: string, repoName: string) => this.getDefaultBranch(npub, repoName)
    });
  }

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

    if (!isValidBranchName(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}`);
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      await git.raw(['branch', branchName, fromBranch]);
      const cacheKey = RepoCache.branchesKey(npub, repoName);
      repoCache.delete(cacheKey);
    } catch (error) {
      logger.error({ error, repoPath, branchName, fromBranch }, 'Error creating branch');
      throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteBranch(npub: string, repoName: string, branchName: string): Promise<void> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    if (!isValidBranchName(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}`);
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      await git.raw(['branch', '-D', branchName]).catch(async () => {
        await git.raw(['update-ref', '-d', `refs/heads/${branchName}`]);
      });

      const cacheKey = RepoCache.branchesKey(npub, repoName);
      repoCache.delete(cacheKey);
    } catch (error) {
      logger.error({ error, repoPath, branchName }, 'Error deleting branch');
      throw new Error(`Failed to delete branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
    return getCommitHistory({ npub, repoName, branch, limit, path, repoPath });
  }

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
    return getDiff({ npub, repoName, fromRef, toRef, filePath, repoPath });
  }

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
    return createTag({ npub, repoName, tagName, ref, message, authorName, authorEmail, repoPath });
  }

  async getTags(npub: string, repoName: string): Promise<Tag[]> {
    const repoPath = this.getRepoPath(npub, repoName);
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }
    return getTags({ npub, repoName, repoPath });
  }

  private async saveCommitSignatureEventToWorktree(worktreePath: string, event: any): Promise<void> {
    try {
      const { mkdir, writeFile } = await this.getFsPromises();
      const nostrDir = join(worktreePath, 'nostr');
      await mkdir(nostrDir, { recursive: true });
      const jsonlFile = join(nostrDir, 'commit-signatures.jsonl');
      const eventLine = JSON.stringify(event) + '\n';
      await writeFile(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
    } catch (err) {
      logger.debug({ error: err, worktreePath }, 'Failed to save commit signature event');
    }
  }

  async saveRepoEventToWorktree(
    worktreePath: string,
    event: any,
    eventType: 'announcement' | 'transfer',
    skipIfExists: boolean = true
  ): Promise<boolean> {
    try {
      const { mkdir, writeFile, readFile } = await this.getFsPromises();
      const nostrDir = join(worktreePath, 'nostr');
      await mkdir(nostrDir, { recursive: true });
      const jsonlFile = join(nostrDir, 'repo-events.jsonl');
      
      if (skipIfExists) {
        try {
          const existingContent = await readFile(jsonlFile, 'utf-8');
          const lines = existingContent.trim().split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.event && parsed.event.id === event.id) {
                return false;
              }
            } catch {
              // Skip invalid lines
            }
          }
        } catch {
          // File doesn't exist yet
        }
      }
      
      const eventLine = JSON.stringify({
        type: eventType,
        timestamp: event.created_at,
        event
      }) + '\n';
      await writeFile(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
      return true;
    } catch (err) {
      logger.debug({ error: err, worktreePath, eventType }, 'Failed to save repo event');
      return false;
    }
  }

  private async isRepoPrivate(npub: string, repoName: string): Promise<boolean> {
    try {
      const { requireNpubHex } = await import('$lib/utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHex(npub);
      const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
      const { DEFAULT_NOSTR_RELAYS } = await import('$lib/config.js');
      const { KIND } = await import('$lib/types/nostr.js');
      
      const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repoName],
          limit: 1
        }
      ]);
      
      if (events.length === 0) return false;
      
      const { isPrivateRepo: checkIsPrivateRepo } = await import('$lib/utils/repo-privacy.js');
      return checkIsPrivateRepo(events[0]);
    } catch (err) {
      logger.debug({ error: err, npub, repoName }, 'Failed to check repo privacy, defaulting to public');
      return false;
    }
  }

  async getCurrentOwnerFromRepo(npub: string, repoName: string): Promise<string | null> {
    try {
      if (!this.repoExists(npub, repoName)) return null;
      
      const repoPath = this.getRepoPath(npub, repoName);
      const git: SimpleGit = simpleGit(repoPath);
      
      const logOutput = await git.raw(['log', '--all', '--format=%H', '--reverse', '--', 'nostr/repo-events.jsonl']);
      const commitHashes = logOutput.trim().split('\n').filter(Boolean);
      
      if (commitHashes.length === 0) return null;
      
      const mostRecentCommit = commitHashes[commitHashes.length - 1];
      const repoEventsFile = await this.getFileContent(npub, repoName, 'nostr/repo-events.jsonl', mostRecentCommit);
      
      let announcementEvent: any = null;
      let latestTimestamp = 0;
      
      try {
        const lines = repoEventsFile.content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'announcement' && entry.event && entry.timestamp) {
              if (entry.timestamp > latestTimestamp) {
                latestTimestamp = entry.timestamp;
                announcementEvent = entry.event;
              }
            }
          } catch {
            continue;
          }
        }
      } catch (parseError) {
        logger.warn({ error: parseError, npub, repoName }, 'Failed to parse repo-events.jsonl');
        return null;
      }
      
      if (!announcementEvent) return null;
      
      const { validateAnnouncementEvent } = await import('$lib/services/nostr/repo-verification.js');
      const validation = validateAnnouncementEvent(announcementEvent, repoName);
      
      if (!validation.valid) {
        logger.warn({ error: validation.error, npub, repoName }, 'Announcement validation failed');
        return null;
      }
      
      return announcementEvent.pubkey;
    } catch (error) {
      logger.error({ error, npub, repoName }, 'Error getting current owner from repo');
      return null;
    }
  }
}
