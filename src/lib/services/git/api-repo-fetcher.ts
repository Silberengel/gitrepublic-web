/**
 * API-based repository fetcher service
 * Fetches repository metadata from external platforms without cloning
 * Supports GitHub, GitLab, Gitea, GRASP, and other git hosting services
 * 
 * This is used by default for displaying repos. Only privileged users
 * can explicitly clone repos to the server.
 */

import logger from '../logger.js';

export interface ApiRepoInfo {
  name: string;
  description?: string;
  url: string;
  defaultBranch: string;
  branches: ApiBranch[];
  commits: ApiCommit[];
  files: ApiFile[];
  readme?: {
    path: string;
    content: string;
    format: 'markdown' | 'asciidoc';
  };
  platform: 'github' | 'gitlab' | 'gitea' | 'grasp' | 'unknown';
  isCloned: boolean; // Whether repo exists locally
}

export interface ApiBranch {
  name: string;
  commit: {
    sha: string;
    message: string;
    author: string;
    date: string;
  };
}

export interface ApiCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface ApiFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

type GitPlatform = 'github' | 'gitlab' | 'gitea' | 'grasp' | 'unknown';

/**
 * Check if a URL is a GRASP (Git Repository Access via Secure Protocol) URL
 * GRASP URLs contain npub (Nostr public key) in the path: https://host/npub.../repo.git
 */
export function isGraspUrl(url: string): boolean {
  return /\/npub1[a-z0-9]+/i.test(url);
}

/**
 * Parse git URL to extract platform, owner, and repo
 */
function parseGitUrl(url: string): { platform: GitPlatform; owner: string; repo: string; baseUrl: string } | null {
  // Handle GRASP URLs - they use Gitea-compatible API but with npub as owner
  if (isGraspUrl(url)) {
    const graspMatch = url.match(/(https?:\/\/[^/]+)\/(npub1[a-z0-9]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (graspMatch) {
      const [, baseHost, npub, repo] = graspMatch;
      return {
        platform: 'grasp',
        owner: npub,
        repo: repo.replace(/\.git$/, ''),
        baseUrl: `${baseHost}/api/v1`
      };
    }
    return null;
  }

  // GitHub
  const githubMatch = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (githubMatch) {
    return {
      platform: 'github',
      owner: githubMatch[1],
      repo: githubMatch[2].replace(/\.git$/, ''),
      baseUrl: 'https://api.github.com'
    };
  }

  // GitLab (both gitlab.com and self-hosted instances)
  const gitlabMatch = url.match(/(https?:\/\/[^/]*gitlab[^/]*)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (gitlabMatch) {
    const baseHost = gitlabMatch[1];
    const baseUrl = baseHost.includes('gitlab.com') 
      ? 'https://gitlab.com/api/v4'
      : `${baseHost}/api/v4`;
    return {
      platform: 'gitlab',
      owner: gitlabMatch[2],
      repo: gitlabMatch[3].replace(/\.git$/, ''),
      baseUrl
    };
  }

  // Gitea and other Git hosting services (generic pattern)
  const giteaMatch = url.match(/(https?:\/\/[^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (giteaMatch) {
    // Double-check it's not a GRASP URL (npub in owner position)
    if (giteaMatch[2].startsWith('npub1')) {
      return null;
    }
    return {
      platform: 'gitea',
      owner: giteaMatch[2],
      repo: giteaMatch[3].replace(/\.git$/, ''),
      baseUrl: `${giteaMatch[1]}/api/v1`
    };
  }

  return null;
}

/**
 * Check if a repository exists locally
 */
async function checkLocalRepo(npub: string, repoName: string): Promise<boolean> {
  try {
    // Dynamic import to avoid bundling Node.js fs in browser
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
    const repoPath = join(repoRoot, npub, `${repoName}.git`);
    return existsSync(repoPath);
  } catch {
    // If we can't check (e.g., in browser), assume not cloned
    return false;
  }
}

/**
 * Fetch repository metadata from GitHub API
 */
async function fetchFromGitHub(owner: string, repo: string): Promise<Partial<ApiRepoInfo> | null> {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GitRepublic'
    };
    
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return null;
      }
      logger.warn({ status: repoResponse.status, owner, repo }, 'GitHub API error');
      return null;
    }

    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'main';

    // Fetch branches, commits, and tree in parallel
    const [branchesResponse, commitsResponse, treeResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, { headers }).catch(() => null),
      fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`, { headers }).catch(() => null),
      fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, { headers }).catch(() => null)
    ]);

    const branches: ApiBranch[] = branchesResponse?.ok 
      ? (await branchesResponse.json()).map((b: any) => ({
          name: b.name,
          commit: {
            sha: b.commit.sha,
            message: b.commit.commit?.message?.split('\n')[0] || 'No commit message',
            author: b.commit.commit?.author?.name || 'Unknown',
            date: b.commit.commit?.author?.date || new Date().toISOString()
          }
        }))
      : [];

    const commits: ApiCommit[] = commitsResponse?.ok
      ? (await commitsResponse.json()).map((c: any) => ({
          sha: c.sha,
          message: c.commit?.message?.split('\n')[0] || 'No commit message',
          author: c.commit?.author?.name || 'Unknown',
          date: c.commit?.author?.date || new Date().toISOString()
        }))
      : [];

    const files: ApiFile[] = treeResponse?.ok
      ? (await treeResponse.json()).tree
          ?.filter((item: any) => item.type === 'blob' || item.type === 'tree')
          .map((item: any) => ({
            name: item.path.split('/').pop(),
            path: item.path,
            type: item.type === 'tree' ? 'dir' : 'file',
            size: item.size
          })) || []
      : [];

    // Try to fetch README
    let readme: { path: string; content: string; format: 'markdown' | 'asciidoc' } | undefined;
    const readmeFiles = ['README.adoc', 'README.md', 'README.rst', 'README.txt'];
    for (const readmeFile of readmeFiles) {
      try {
        const readmeResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${readmeFile}?ref=${defaultBranch}`,
          { headers }
        );
        if (readmeResponse.ok) {
          const readmeData = await readmeResponse.json();
          if (readmeData.content) {
            const content = atob(readmeData.content.replace(/\s/g, ''));
            readme = {
              path: readmeFile,
              content,
              format: readmeFile.toLowerCase().endsWith('.adoc') ? 'asciidoc' : 'markdown'
            };
            break;
          }
        }
      } catch {
        continue;
      }
    }

    return {
      name: repoData.name,
      description: repoData.description,
      url: repoData.html_url,
      defaultBranch,
      branches,
      commits,
      files,
      readme,
      platform: 'github'
    };
  } catch (error) {
    logger.error({ error, owner, repo }, 'Error fetching from GitHub');
    return null;
  }
}

/**
 * Fetch repository metadata from GitLab API
 * Note: This is a simplified version. For full implementation, see aitherboard's git-repo-fetcher.ts
 */
async function fetchFromGitLab(owner: string, repo: string, baseUrl: string): Promise<Partial<ApiRepoInfo> | null> {
  try {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const repoResponse = await fetch(`${baseUrl}/projects/${projectPath}`);
    
    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return null;
      }
      return null;
    }

    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'master';

    // For now, return basic info. Full implementation would fetch branches, commits, files
    return {
      name: repoData.name,
      description: repoData.description,
      url: repoData.web_url,
      defaultBranch,
      branches: [],
      commits: [],
      files: [],
      platform: 'gitlab'
    };
  } catch (error) {
    logger.error({ error, owner, repo }, 'Error fetching from GitLab');
    return null;
  }
}

/**
 * Fetch repository metadata from Gitea API
 */
async function fetchFromGitea(owner: string, repo: string, baseUrl: string): Promise<Partial<ApiRepoInfo> | null> {
  try {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const repoResponse = await fetch(`${baseUrl}/repos/${encodedOwner}/${encodedRepo}`);
    
    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return null;
      }
      return null;
    }

    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'master';

    return {
      name: repoData.name,
      description: repoData.description,
      url: repoData.html_url || repoData.clone_url,
      defaultBranch,
      branches: [],
      commits: [],
      files: [],
      platform: 'gitea'
    };
  } catch (error) {
    logger.error({ error, owner, repo }, 'Error fetching from Gitea');
    return null;
  }
}

/**
 * Fetch repository metadata from GRASP
 * GRASP repos use git protocol, so we can't easily fetch metadata via API
 * For now, return minimal info indicating it's a GRASP repo
 */
async function fetchFromGrasp(npub: string, repo: string, baseUrl: string, originalUrl: string): Promise<Partial<ApiRepoInfo> | null> {
  // GRASP repos typically don't have REST APIs
  // Full implementation would use git protocol (info/refs, git-upload-pack)
  // For now, return basic structure
  return {
    name: repo,
    description: undefined,
    url: originalUrl,
    defaultBranch: 'main',
    branches: [],
    commits: [],
    files: [],
    platform: 'grasp'
  };
}

/**
 * Fetch repository metadata from a git URL
 * This is the main entry point for API-based fetching
 */
export async function fetchRepoMetadata(
  url: string,
  npub: string,
  repoName: string
): Promise<ApiRepoInfo | null> {
  const parsed = parseGitUrl(url);
  if (!parsed) {
    logger.warn({ url }, 'Unable to parse git URL');
    return null;
  }

  const { platform, owner, repo, baseUrl } = parsed;
  const isCloned = await checkLocalRepo(npub, repoName);

  let metadata: Partial<ApiRepoInfo> | null = null;

  switch (platform) {
    case 'github':
      metadata = await fetchFromGitHub(owner, repo);
      break;
    case 'gitlab':
      metadata = await fetchFromGitLab(owner, repo, baseUrl);
      break;
    case 'gitea':
      metadata = await fetchFromGitea(owner, repo, baseUrl);
      break;
    case 'grasp':
      metadata = await fetchFromGrasp(owner, repo, baseUrl, url);
      break;
    default:
      logger.warn({ platform, url }, 'Unsupported platform');
      return null;
  }

  if (!metadata) {
    return null;
  }

  return {
    ...metadata,
    isCloned,
    platform
  } as ApiRepoInfo;
}

/**
 * Extract git URLs from a Nostr repo announcement event
 */
export function extractGitUrls(event: { tags: string[][] }): string[] {
  const urls: string[] = [];
  
  for (const tag of event.tags) {
    if (tag[0] === 'clone') {
      // Clone tags can have multiple URLs: ["clone", "url1", "url2", "url3"]
      for (let i = 1; i < tag.length; i++) {
        const url = tag[i];
        if (url && typeof url === 'string' && (url.startsWith('http') || url.startsWith('git@'))) {
          urls.push(url);
        }
      }
    }
  }
  
  return [...new Set(urls)]; // Deduplicate
}
