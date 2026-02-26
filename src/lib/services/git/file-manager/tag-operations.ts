/**
 * Tag operations module
 * Handles tag creation and listing
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../../logger.js';
import { validateRepoName, validateNpub } from './path-validator.js';
import type { Tag } from '../file-manager.js';

export interface CreateTagOptions {
  npub: string;
  repoName: string;
  tagName: string;
  ref?: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  repoPath: string;
}

export interface GetTagsOptions {
  npub: string;
  repoName: string;
  repoPath: string;
}

/**
 * Create a tag
 */
export async function createTag(options: CreateTagOptions): Promise<void> {
  const { npub, repoName, tagName, ref = 'HEAD', message, repoPath } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Creating tag', { npub, repoName, tagName, ref });

    // Check if repository has any commits
    let hasCommits = false;
    let actualRef = ref;
    
    try {
      const headCommit = await git.raw(['rev-parse', 'HEAD']).catch(() => null);
      hasCommits = !!(headCommit && headCommit.trim().length > 0);
    } catch {
      // Check if any branch has commits
      try {
        const branches = await git.branch(['-a']);
        for (const branch of branches.all) {
          const branchName = branch.replace(/^remotes\/origin\//, '').replace(/^remotes\//, '');
          if (branchName.includes('HEAD')) continue;
          try {
            const commitHash = await git.raw(['rev-parse', `refs/heads/${branchName}`]).catch(() => null);
            if (commitHash && commitHash.trim().length > 0) {
              hasCommits = true;
              if (ref === 'HEAD') {
                actualRef = branchName;
              }
              break;
            }
          } catch {
            // Continue checking other branches
          }
        }
      } catch {
        // Could not check branches
      }
    }

    if (!hasCommits) {
      throw new Error('Cannot create tag: repository has no commits. Please create at least one commit first.');
    }

    // Validate that the ref exists
    try {
      await git.raw(['rev-parse', '--verify', actualRef]);
    } catch (refErr) {
      throw new Error(`Invalid reference '${actualRef}': ${refErr instanceof Error ? refErr.message : String(refErr)}`);
    }

    if (message) {
      // Create annotated tag
      if (actualRef !== 'HEAD') {
        await git.raw(['tag', '-a', tagName, '-m', message, actualRef]);
      } else {
        await git.raw(['tag', '-a', tagName, '-m', message]);
      }
    } else {
      // Create lightweight tag
      if (actualRef !== 'HEAD') {
        await git.raw(['tag', tagName, actualRef]);
      } else {
        await git.addTag(tagName);
      }
    }

    logger.operation('Tag created', { npub, repoName, tagName });
  } catch (error) {
    logger.error({ error, repoPath, tagName, ref }, 'Error creating tag');
    throw new Error(`Failed to create tag: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get list of tags
 */
export async function getTags(options: GetTagsOptions): Promise<Tag[]> {
  const { npub, repoName, repoPath } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Getting tags', { npub, repoName });

    const tags = await git.tags();
    const tagList: Tag[] = [];

    for (const tagName of tags.all) {
      try {
        // Get the commit hash the tag points to
        const hash = await git.raw(['rev-parse', tagName]);
        const commitHash = hash.trim();
        
        // Get the commit date (Unix timestamp)
        let commitDate: number | undefined;
        try {
          const dateStr = await git.raw(['log', '-1', '--format=%at', commitHash]);
          commitDate = parseInt(dateStr.trim(), 10);
          if (isNaN(commitDate)) {
            commitDate = undefined;
          }
        } catch {
          commitDate = undefined;
        }
        
        // Try to get tag message (for annotated tags)
        try {
          const tagInfo = await git.raw(['cat-file', '-p', tagName]);
          const messageMatch = tagInfo.match(/^(.+)$/m);
          
          tagList.push({
            name: tagName,
            hash: commitHash,
            message: messageMatch ? messageMatch[1] : undefined,
            date: commitDate
          });
        } catch {
          // Lightweight tag - no message
          tagList.push({
            name: tagName,
            hash: commitHash,
            date: commitDate
          });
        }
      } catch (err) {
        logger.warn({ error: err, tagName }, 'Error processing tag, skipping');
      }
    }

    logger.operation('Tags retrieved', { npub, repoName, count: tagList.length });
    return tagList;
  } catch (error) {
    logger.error({ error, repoPath }, 'Error getting tags');
    return [];
  }
}
