/**
 * File manager for git repositories
 * Handles reading, writing, and listing files in git repos
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { RepoManager } from './repo-manager.js';

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
    return join(this.repoRoot, npub, `${repoName}.git`);
  }

  /**
   * Check if repository exists
   */
  repoExists(npub: string, repoName: string): boolean {
    const repoPath = this.getRepoPath(npub, repoName);
    return this.repoManager.repoExists(repoPath);
  }

  /**
   * List files and directories in a repository at a given path
   */
  async listFiles(npub: string, repoName: string, ref: string = 'HEAD', path: string = ''): Promise<FileEntry[]> {
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
      console.error('Error listing files:', error);
      throw new Error(`Failed to list files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get file content from a repository
   */
  async getFileContent(npub: string, repoName: string, filePath: string, ref: string = 'HEAD'): Promise<FileContent> {
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
      console.error('Error reading file:', error);
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Write file and commit changes
   */
  async writeFile(
    npub: string,
    repoName: string,
    filePath: string,
    content: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main'
  ): Promise<void> {
    const repoPath = this.getRepoPath(npub, repoName);
    
    if (!this.repoExists(npub, repoName)) {
      throw new Error('Repository not found');
    }

    try {
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

      // Write the file
      const fullFilePath = join(workDir, filePath);
      const fileDir = dirname(fullFilePath);
      
      // Ensure directory exists
      if (!existsSync(fileDir)) {
        const { mkdir } = await import('fs/promises');
        await mkdir(fileDir, { recursive: true });
      }

      const { writeFile: writeFileFs } = await import('fs/promises');
      await writeFileFs(fullFilePath, content, 'utf-8');

      // Stage the file
      await workGit.add(filePath);

      // Commit
      await workGit.commit(commitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo
      await workGit.push(['origin', branch]);

      // Clean up work directory
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Error writing file:', error);
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
      console.error('Error getting branches:', error);
      return ['main', 'master']; // Default branches
    }
  }

  /**
   * Create a new file
   */
  async createFile(
    npub: string,
    repoName: string,
    filePath: string,
    content: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main'
  ): Promise<void> {
    // Reuse writeFile logic - it will create the file if it doesn't exist
    return this.writeFile(npub, repoName, filePath, content, commitMessage, authorName, authorEmail, branch);
  }

  /**
   * Delete a file
   */
  async deleteFile(
    npub: string,
    repoName: string,
    filePath: string,
    commitMessage: string,
    authorName: string,
    authorEmail: string,
    branch: string = 'main'
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

      try {
        await workGit.checkout([branch]);
      } catch {
        await workGit.checkout(['-b', branch]);
      }

      // Remove the file
      const fullFilePath = join(workDir, filePath);
      if (existsSync(fullFilePath)) {
        const { unlink } = await import('fs/promises');
        await unlink(fullFilePath);
      }

      // Stage the deletion
      await workGit.rm([filePath]);

      // Commit
      await workGit.commit(commitMessage, [filePath], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to bare repo
      await workGit.push(['origin', branch]);

      // Clean up
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Error deleting file:', error);
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
      console.error('Error creating branch:', error);
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
      console.error('Error getting commit history:', error);
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
          if (file) {
            file.additions = statFile.insertions;
            file.deletions = statFile.deletions;
          }
        }
      }

      return files;
    } catch (error) {
      console.error('Error getting diff:', error);
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
        const tagOptions: string[] = ['-a', tagName, '-m', message];
        if (ref !== 'HEAD') {
          tagOptions.push(ref);
        }
        await git.addTag(tagName, message);
      } else {
        // Create lightweight tag
        await git.addTag(tagName);
      }
    } catch (error) {
      console.error('Error creating tag:', error);
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
      console.error('Error getting tags:', error);
      return [];
    }
  }
}
