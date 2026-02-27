/**
 * File Manager - Core service for git repository operations
 * Handles branches, files, commits, tags, and worktrees
 */

import { join, resolve } from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { RepoManager } from './repo-manager.js';
import logger from '$lib/services/logger.js';
import { isValidBranchName } from '$lib/utils/security.js';
import { repoCache, RepoCache } from './repo-cache.js';

// Import modular operations
import { getOrCreateWorktree, removeWorktree } from './file-manager/worktree-manager.js';
import { validateFilePath, validateRepoName, validateNpub } from './file-manager/path-validator.js';
import { listFiles, getFileContent } from './file-manager/file-operations.js';
import { getBranches as getBranchesModule } from './file-manager/branch-operations.js';
import { writeFile, deleteFile } from './file-manager/write-operations.js';
import { getCommitHistory, getDiff } from './file-manager/commit-operations.js';
import { createTag, getTags } from './file-manager/tag-operations.js';

// Type definitions
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

    const repoSizeCheck = await this.repoManager.checkRepoSizeLimit(repoPath);
    if (!repoSizeCheck.withinLimit) {
      throw new Error(repoSizeCheck.error || 'Repository size limit exceeded');
    }

    const worktreePath = await this.getWorktree(repoPath, branch, npub, repoName);

    const saveCommitSignature = async (worktreePath: string, event: any) => {
      await this.saveCommitSignatureEventToWorktree(worktreePath, event);
    };

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
      // HEAD doesn't point to a branch, try remote
    }

    try {
      const remoteHead = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      if (remoteHead) {
        const match = remoteHead.trim().match(/^refs\/remotes\/origin\/(.+)$/);
        if (match) return match[1];
      }
    } catch {
      // No remote HEAD
    }

    // Try to get branches and find main/master
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
    return getBranchesModule({
      npub,
      repoName,
      repoPath,
      getDefaultBranch: (npub: string, repoName: string) => this.getDefaultBranch(npub, repoName)
    });
  }

  /**
   * Create a branch in a repository
   * Handles empty repositories by creating orphan branches
   */
  async createBranch(
    npub: string,
    repoName: string,
    branchName: string,
    fromBranch?: string
  ): Promise<void> {
    logger.info({ npub, repoName, branchName, fromBranch }, '[FileManager.createBranch] START - called with parameters');
    
    const repoPath = this.getRepoPath(npub, repoName);
    logger.info({ npub, repoName, repoPath }, '[FileManager.createBranch] Repository path resolved');
    
    if (!this.repoExists(npub, repoName)) {
      logger.error({ npub, repoName, repoPath }, '[FileManager.createBranch] Repository does not exist');
      throw new Error('Repository not found');
    }
    logger.info({ npub, repoName }, '[FileManager.createBranch] Repository exists confirmed');

    if (!isValidBranchName(branchName)) {
      logger.error({ npub, repoName, branchName }, '[FileManager.createBranch] Invalid branch name');
      throw new Error(`Invalid branch name: ${branchName}`);
    }
    logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Branch name validated');

    const git: SimpleGit = simpleGit(repoPath);
    logger.info({ npub, repoName, repoPath }, '[FileManager.createBranch] Git instance created');

    try {
      // Check if repository has any commits - use multiple methods for reliability
      let hasCommits = false;
      let commitCount = 0;
      try {
        // Method 1: rev-list count
        const commitCountStr = await git.raw(['rev-list', '--count', '--all']);
        commitCount = parseInt(commitCountStr.trim(), 10);
        hasCommits = !isNaN(commitCount) && commitCount > 0;
        
        logger.info({ npub, repoName, branchName, fromBranch, commitCount, hasCommits }, '[FileManager] createBranch - rev-list result');
        
        // Method 2: Verify by checking if any refs exist
        if (hasCommits) {
          try {
            const refs = await git.raw(['for-each-ref', '--count=1', 'refs/heads/']);
            if (!refs || refs.trim().length === 0) {
              hasCommits = false;
              logger.warn({ npub, repoName }, '[FileManager] No refs found despite commit count, treating as empty');
            }
          } catch (refError) {
            hasCommits = false;
            logger.warn({ npub, repoName, error: refError }, '[FileManager] Failed to check refs, treating as empty');
          }
        }
      } catch (revListError) {
        // rev-list fails for empty repos - this is expected
        hasCommits = false;
        logger.info({ npub, repoName, error: revListError }, '[FileManager] rev-list failed (empty repo expected)');
      }

      // CRITICAL SAFETY: Use local variable and clear it if no commits
      let sourceBranch: string | undefined = fromBranch;
      
      // CRITICAL SAFETY: If fromBranch is 'master' or 'main' and we have no commits, clear it
      if ((sourceBranch === 'master' || sourceBranch === 'main') && !hasCommits) {
        logger.error({ npub, repoName, sourceBranch, hasCommits }, '[FileManager] ERROR: sourceBranch is master/main but no commits! Clearing it.');
        sourceBranch = undefined;
      }
      
      // CRITICAL: If no commits, ALWAYS clear sourceBranch
      if (!hasCommits) {
        sourceBranch = undefined;
        logger.info({ npub, repoName }, '[FileManager] No commits - forcing sourceBranch to undefined');
      }

      logger.info({ npub, repoName, branchName, sourceBranch, fromBranch, hasCommits, commitCount }, '[FileManager] createBranch - final values before branch creation');

      // CRITICAL: If repo has no commits, ALWAYS create orphan branch (completely ignore sourceBranch)
      if (!hasCommits) {
        logger.info({ npub, repoName, branchName, sourceBranch, fromBranch, hasCommits }, '[FileManager.createBranch] PATH: Creating orphan branch (no commits)');
        // For empty repos, we need to create an empty commit first, then create the branch
        // This is the only way git will recognize the branch
        try {
          // Fetch user profile to get author name and email
          let authorName = 'GitRepublic User';
          let authorEmail = 'gitrepublic@gitrepublic.web';
          try {
            const { requireNpubHex } = await import('$lib/utils/npub-utils.js');
            const { fetchUserProfile, extractProfileData, getUserName, getUserEmail } = await import('$lib/utils/user-profile.js');
            const { DEFAULT_NOSTR_RELAYS } = await import('$lib/config.js');
            const userPubkeyHex = requireNpubHex(npub);
            const profileEvent = await fetchUserProfile(userPubkeyHex, DEFAULT_NOSTR_RELAYS);
            const profile = extractProfileData(profileEvent);
            authorName = getUserName(profile, userPubkeyHex, npub);
            authorEmail = getUserEmail(profile, userPubkeyHex, npub);
            logger.info({ npub, repoName, authorName, authorEmail }, '[FileManager.createBranch] Fetched user profile for author identity');
          } catch (profileError) {
            logger.warn({ npub, repoName, error: profileError }, '[FileManager.createBranch] Failed to fetch user profile, using defaults');
          }
          
          // Set git config for user.name and user.email in this repository
          // This is required for commit-tree to work without errors
          try {
            await git.addConfig('user.name', authorName, false, 'local');
            await git.addConfig('user.email', authorEmail, false, 'local');
            logger.info({ npub, repoName, authorName, authorEmail }, '[FileManager.createBranch] Set git config for user.name and user.email');
          } catch (configError) {
            logger.warn({ npub, repoName, error: configError }, '[FileManager.createBranch] Failed to set git config, will use --author flag');
          }
          
          logger.info({ npub, repoName, branchName, repoPath }, '[FileManager.createBranch] Step 1: Creating empty tree for initial commit');
          // Create empty tree object - empty tree hash is always the same: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
          // We'll use mktree to create it if needed
          let emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          // Ensure it exists in the repo
          try {
            await git.raw(['cat-file', '-e', emptyTreeHash]);
            logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Empty tree already exists in repo');
          } catch {
            // Create it using mktree with empty input
            logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Creating empty tree object');
            const { spawn } = await import('child_process');
            const createdHash = await new Promise<string>((resolve, reject) => {
              const proc = spawn('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: repoPath });
              proc.stdin.end();
              let output = '';
              proc.stdout.on('data', (data) => { output += data.toString(); });
              proc.on('close', (code) => {
                if (code === 0) resolve(output.trim());
                else reject(new Error(`hash-object failed with code ${code}`));
              });
              proc.on('error', reject);
            });
            emptyTreeHash = createdHash || emptyTreeHash;
            logger.info({ npub, repoName, branchName, emptyTreeHash }, '[FileManager.createBranch] Created empty tree object');
          }
          logger.info({ npub, repoName, branchName, emptyTreeHash }, '[FileManager.createBranch] Step 1 complete: empty tree ready');
          
          logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Step 2: Creating empty commit');
          // Create an empty commit pointing to the empty tree with author information
          // Use --author flag to specify author identity (required when git config is not set)
          const authorString = `${authorName} <${authorEmail}>`;
          const commitHash = await git.raw(['commit-tree', '-m', `Initial commit on ${branchName}`, '--author', authorString, emptyTreeHash]);
          const commit = commitHash.trim();
          logger.info({ npub, repoName, branchName, commit }, '[FileManager.createBranch] Step 2 complete: empty commit created');
          
          logger.info({ npub, repoName, branchName, commit }, '[FileManager.createBranch] Step 3: Creating branch ref pointing to empty commit');
          // Create the branch ref pointing to the empty commit
          const updateRefResult = await git.raw(['update-ref', `refs/heads/${branchName}`, commit]);
          logger.info({ npub, repoName, branchName, commit, updateRefResult }, '[FileManager.createBranch] Step 3 complete: update-ref created branch');
          
          logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Step 4: Setting HEAD to point to new branch');
          // Set HEAD to point to the new branch
          const symRefResult = await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branchName}`]);
          logger.info({ npub, repoName, branchName, symRefResult }, '[FileManager.createBranch] Step 4 complete: symbolic-ref HEAD set');
          
          // Verify the branch was created
          try {
            const branches = await git.branchLocal();
            logger.info({ npub, repoName, branchName, branches: branches.all }, '[FileManager.createBranch] Verification: branch list after creation');
          } catch (verifyErr) {
            logger.warn({ npub, repoName, branchName, error: verifyErr }, '[FileManager.createBranch] Warning: Could not verify branch in list');
          }
          
          logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] SUCCESS: Orphan branch created with empty commit');
        } catch (orphanError) {
          logger.error({ 
            error: orphanError, 
            errorMessage: orphanError instanceof Error ? orphanError.message : String(orphanError),
            errorStack: orphanError instanceof Error ? orphanError.stack : undefined,
            npub, 
            repoName, 
            branchName,
            sourceBranch,
            fromBranch,
            hasCommits,
            repoPath
          }, '[FileManager.createBranch] ERROR: Failed to create orphan branch');
          throw new Error(`Failed to create orphan branch: ${orphanError instanceof Error ? orphanError.message : String(orphanError)}`);
        }
      } else if (!sourceBranch) {
        // Repository has commits but no source branch - create orphan branch
        logger.info({ npub, repoName, branchName, hasCommits }, '[FileManager.createBranch] PATH: Creating orphan branch (has commits but no source branch)');
        logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Setting HEAD to new branch');
        await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branchName}`]);
        logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Creating branch');
        await git.raw(['branch', branchName]);
        logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] SUCCESS: Orphan branch created');
      } else {
        // Repository has commits and source branch provided - verify it exists first
        logger.info({ npub, repoName, branchName, sourceBranch, hasCommits }, '[FileManager.createBranch] PATH: Creating branch from source');
        try {
          logger.info({ npub, repoName, sourceBranch }, '[FileManager.createBranch] Verifying source branch exists');
          // Verify the source branch exists
          const verifyResult = await git.raw(['rev-parse', '--verify', `refs/heads/${sourceBranch}`]);
          logger.info({ npub, repoName, sourceBranch, verifyResult }, '[FileManager.createBranch] Source branch verified, creating branch');
          await git.raw(['branch', branchName, sourceBranch]);
          logger.info({ npub, repoName, branchName, sourceBranch }, '[FileManager.createBranch] SUCCESS: Branch created from source');
        } catch (verifyError) {
          // Source branch doesn't exist - create orphan branch instead
          logger.warn({ 
            npub, 
            repoName, 
            branchName, 
            sourceBranch, 
            error: verifyError,
            errorMessage: verifyError instanceof Error ? verifyError.message : String(verifyError)
          }, '[FileManager.createBranch] Source branch does not exist, creating orphan branch instead');
          await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branchName}`]);
          await git.raw(['branch', branchName]);
          logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] SUCCESS: Orphan branch created (fallback)');
        }
      }
      
      // Clear branch cache
      const cacheKey = RepoCache.branchesKey(npub, repoName);
      repoCache.delete(cacheKey);
      logger.info({ npub, repoName, branchName }, '[FileManager.createBranch] Branch cache cleared');
    } catch (error) {
      logger.error({ 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        repoPath, 
        branchName, 
        fromBranch,
        npub,
        repoName
      }, '[FileManager.createBranch] ERROR: Exception caught in createBranch');
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
