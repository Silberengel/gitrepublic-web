/**
 * Repository API hooks
 * Centralized API calls for repository operations
 */

import { buildApiHeaders } from '../utils/api-client.js';
import logger from '$lib/services/logger.js';

export interface LoadFilesOptions {
  npub: string;
  repo: string;
  branch: string;
  path?: string;
}

export interface LoadFileOptions {
  npub: string;
  repo: string;
  branch: string;
  filePath: string;
}

/**
 * Load files from repository
 */
export async function loadFiles(options: LoadFilesOptions): Promise<Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>> {
  const { npub, repo, branch, path = '' } = options;
  
  try {
    logger.operation('Loading files', { npub, repo, branch, path });
    
    const url = `/api/repos/${npub}/${repo}/tree?ref=${branch}${path ? `&path=${encodeURIComponent(path)}` : ''}`;
    const response = await fetch(url, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load files: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('Files loaded', { npub, repo, count: data.files?.length || 0 });
    return data.files || [];
  } catch (error) {
    logger.error({ error, npub, repo, branch, path }, 'Error loading files');
    throw error;
  }
}

/**
 * Load file content
 */
export async function loadFile(options: LoadFileOptions): Promise<{ content: string; type: string }> {
  const { npub, repo, branch, filePath } = options;
  
  try {
    logger.operation('Loading file', { npub, repo, branch, filePath });
    
    const url = `/api/repos/${npub}/${repo}/raw?path=${encodeURIComponent(filePath)}&ref=${branch}`;
    const response = await fetch(url, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load file: ${response.statusText}`);
    }
    
    const content = await response.text();
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const type = ext === 'md' || ext === 'markdown' ? 'markdown' : 
                 ext === 'adoc' || ext === 'asciidoc' ? 'asciidoc' : 'text';
    
    logger.operation('File loaded', { npub, repo, filePath, size: content.length });
    return { content, type };
  } catch (error) {
    logger.error({ error, npub, repo, branch, filePath }, 'Error loading file');
    throw error;
  }
}

/**
 * Load branches
 */
export async function loadBranches(npub: string, repo: string): Promise<string[]> {
  try {
    logger.operation('Loading branches', { npub, repo });
    
    const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load branches: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('Branches loaded', { npub, repo, count: data.branches?.length || 0 });
    return data.branches || [];
  } catch (error) {
    logger.error({ error, npub, repo }, 'Error loading branches');
    throw error;
  }
}

/**
 * Load commit history
 */
export async function loadCommitHistory(
  npub: string,
  repo: string,
  branch: string,
  limit: number = 50
): Promise<Array<{ hash: string; message: string; author: string; date: string; files: string[] }>> {
  try {
    logger.operation('Loading commit history', { npub, repo, branch, limit });
    
    const response = await fetch(`/api/repos/${npub}/${repo}/commits?branch=${branch}&limit=${limit}`, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load commit history: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('Commit history loaded', { npub, repo, count: data.commits?.length || 0 });
    return data.commits || [];
  } catch (error) {
    logger.error({ error, npub, repo, branch }, 'Error loading commit history');
    throw error;
  }
}

/**
 * Load issues
 */
export async function loadIssues(npub: string, repo: string): Promise<Array<any>> {
  try {
    logger.operation('Loading issues', { npub, repo });
    
    const response = await fetch(`/api/repos/${npub}/${repo}/issues`, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load issues: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('Issues loaded', { npub, repo, count: data.issues?.length || 0 });
    return data.issues || [];
  } catch (error) {
    logger.error({ error, npub, repo }, 'Error loading issues');
    throw error;
  }
}

/**
 * Load pull requests
 */
export async function loadPRs(npub: string, repo: string): Promise<Array<any>> {
  try {
    logger.operation('Loading PRs', { npub, repo });
    
    const response = await fetch(`/api/repos/${npub}/${repo}/prs`, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load PRs: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('PRs loaded', { npub, repo, count: data.prs?.length || 0 });
    return data.prs || [];
  } catch (error) {
    logger.error({ error, npub, repo }, 'Error loading PRs');
    throw error;
  }
}

/**
 * Load patches
 */
export async function loadPatches(npub: string, repo: string): Promise<Array<any>> {
  try {
    logger.operation('Loading patches', { npub, repo });
    
    const response = await fetch(`/api/repos/${npub}/${repo}/patches`, {
      headers: buildApiHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load patches: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.operation('Patches loaded', { npub, repo, count: data.patches?.length || 0 });
    return data.patches || [];
  } catch (error) {
    logger.error({ error, npub, repo }, 'Error loading patches');
    throw error;
  }
}
