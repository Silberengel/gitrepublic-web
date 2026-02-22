/**
 * API-based repository fetcher service
 * Fetches repository metadata from external platforms without cloning
 * Supports GitHub, GitLab, Gitea, GRASP, and other git hosting services
 * 
 * This is used by default for displaying repos. Only privileged users
 * can explicitly clone repos to the server.
 */

import logger from '../logger.js';

/**
 * Check if we're running on the server (Node.js) or client (browser)
 */
function isServerSide(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

/**
 * Get the base URL for API requests
 * On server-side, call APIs directly. On client-side, use proxy to avoid CORS.
 */
function getApiBaseUrl(apiPath: string, baseUrl: string, searchParams: URLSearchParams): string {
  if (isServerSide()) {
    // Server-side: call API directly
    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const cleanApiPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const queryString = searchParams.toString();
    return `${cleanBaseUrl}${cleanApiPath}${queryString ? `?${queryString}` : ''}`;
  } else {
    // Client-side: use proxy to avoid CORS
    const queryString = new URLSearchParams({
      baseUrl,
      ...Object.fromEntries(searchParams.entries())
    }).toString();
    return `/api/gitea-proxy/${apiPath}?${queryString}`;
  }
}

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
export function parseGitUrl(url: string): { platform: GitPlatform; owner: string; repo: string; baseUrl: string } | null {
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

    let files: ApiFile[] = [];
    if (treeResponse?.ok) {
      const treeData = await treeResponse.json();
      // Check if the tree was truncated (GitHub API limitation)
      if (treeData.truncated) {
        logger.warn({ owner, repo }, 'GitHub tree response was truncated, some files may be missing');
        // For truncated trees, we could make additional requests, but for now just log a warning
      }
      files = treeData.tree
        ?.filter((item: any) => item.type === 'blob' || item.type === 'tree')
        .map((item: any) => ({
          name: item.path.split('/').pop(),
          path: item.path,
          type: item.type === 'tree' ? 'dir' : 'file',
          size: item.size
        })) || [];
    }

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
 */
async function fetchFromGitLab(owner: string, repo: string, baseUrl: string): Promise<Partial<ApiRepoInfo> | null> {
  try {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    
    // Use proxy endpoint on client-side, direct API on server-side
    const repoUrl = getApiBaseUrl(
      `projects/${projectPath}`,
      baseUrl,
      new URLSearchParams()
    );
    const repoResponse = await fetch(repoUrl);
    
    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return null;
      }
      logger.warn({ status: repoResponse.status, owner, repo }, 'GitLab API error');
      return null;
    }

    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'master';

    // Fetch branches and commits in parallel
    const [branchesResponse, commitsResponse] = await Promise.all([
      fetch(getApiBaseUrl(
        `projects/${projectPath}/repository/branches`,
        baseUrl,
        new URLSearchParams()
      )).catch(() => null),
      fetch(getApiBaseUrl(
        `projects/${projectPath}/repository/commits`,
        baseUrl,
        new URLSearchParams({ per_page: '10' })
      )).catch(() => null)
    ]);

    let branchesData: any[] = [];
    let commitsData: any[] = [];

    if (branchesResponse && branchesResponse.ok) {
      branchesData = await branchesResponse.json();
      if (!Array.isArray(branchesData)) {
        logger.warn({ owner, repo }, 'GitLab branches response is not an array');
        branchesData = [];
      }
    }

    if (commitsResponse && commitsResponse.ok) {
      commitsData = await commitsResponse.json();
      if (!Array.isArray(commitsData)) {
        logger.warn({ owner, repo }, 'GitLab commits response is not an array');
        commitsData = [];
      }
    }

    const branches: ApiBranch[] = branchesData.map((b: any) => ({
      name: b.name,
      commit: {
        sha: b.commit.id,
        message: b.commit.message.split('\n')[0],
        author: b.commit.author_name,
        date: b.commit.committed_date
      }
    }));

    const commits: ApiCommit[] = commitsData.map((c: any) => ({
      sha: c.id,
      message: c.message.split('\n')[0],
      author: c.author_name,
      date: c.committed_date
    }));

    // Fetch file tree (simplified - GitLab tree API is more complex)
    let files: ApiFile[] = [];
    try {
      const treeResponse = await fetch(getApiBaseUrl(
        `projects/${projectPath}/repository/tree`,
        baseUrl,
        new URLSearchParams({ recursive: 'true', per_page: '100' })
      )).catch(() => null);
      if (treeResponse && treeResponse.ok) {
        const treeData = await treeResponse.json();
        if (Array.isArray(treeData)) {
          files = treeData.map((item: any) => ({
            name: item.name,
            path: item.path,
            type: item.type === 'tree' ? 'dir' : 'file',
            size: item.size
          }));
        }
      }
    } catch (error) {
      logger.warn({ error, owner, repo }, 'Failed to fetch GitLab file tree');
    }

    // Try to fetch README
    let readme: { path: string; content: string; format: 'markdown' | 'asciidoc' } | undefined;
    const readmeFiles = ['README.adoc', 'README.md', 'README.rst', 'README.txt'];
    for (const readmeFile of readmeFiles) {
      try {
        const readmeUrl = getApiBaseUrl(
          `projects/${projectPath}/repository/files/${encodeURIComponent(readmeFile)}/raw`,
          baseUrl,
          new URLSearchParams({ ref: defaultBranch })
        );
        const fileData = await fetch(readmeUrl).then(r => {
          if (!r.ok) {
            throw new Error('Not found');
          }
          return r.text();
        });
        readme = {
          path: readmeFile,
          content: fileData,
          format: readmeFile.toLowerCase().endsWith('.adoc') ? 'asciidoc' : 'markdown'
        };
        break; // Found a README, stop searching
      } catch (error) {
        continue; // Try next file
      }
    }

    return {
      name: repoData.name,
      description: repoData.description,
      url: repoData.web_url,
      defaultBranch,
      branches,
      commits,
      files,
      readme,
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
    // URL-encode owner and repo to handle special characters
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    
    // Use proxy endpoint on client-side, direct API on server-side
    const repoUrl = getApiBaseUrl(
      `repos/${encodedOwner}/${encodedRepo}`,
      baseUrl,
      new URLSearchParams()
    );
    const repoResponse = await fetch(repoUrl);
    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return null;
      }
      logger.warn({ status: repoResponse.status, owner, repo }, 'Gitea API error');
      return null;
    }
    const repoData = await repoResponse.json();
    
    const defaultBranch = repoData.default_branch || 'master';
    
    const [branchesResponse, commitsResponse] = await Promise.all([
      fetch(getApiBaseUrl(
        `repos/${encodedOwner}/${encodedRepo}/branches`,
        baseUrl,
        new URLSearchParams()
      )).catch(() => null),
      fetch(getApiBaseUrl(
        `repos/${encodedOwner}/${encodedRepo}/commits`,
        baseUrl,
        new URLSearchParams({ limit: '10' })
      )).catch(() => null)
    ]);
    
    let branchesData: any[] = [];
    let commitsData: any[] = [];
    
    if (branchesResponse && branchesResponse.ok) {
      branchesData = await branchesResponse.json();
      if (!Array.isArray(branchesData)) {
        logger.warn({ owner, repo }, 'Gitea branches response is not an array');
        branchesData = [];
      }
    } else {
      logger.warn({ status: branchesResponse?.status, owner, repo }, 'Gitea API error for branches');
    }
    
    if (commitsResponse && commitsResponse.ok) {
      commitsData = await commitsResponse.json();
      if (!Array.isArray(commitsData)) {
        logger.warn({ owner, repo }, 'Gitea commits response is not an array');
        commitsData = [];
      }
    } else {
      logger.warn({ status: commitsResponse?.status, owner, repo }, 'Gitea API error for commits');
    }

    const branches: ApiBranch[] = branchesData.map((b: any) => {
      const commitObj = b.commit || {};
      return {
        name: b.name || '',
        commit: {
          sha: commitObj.id || b.commit?.sha || '',
          message: commitObj.message ? commitObj.message.split('\n')[0] : 'No commit message',
          author: commitObj.author?.name || commitObj.author_name || 'Unknown',
          date: commitObj.timestamp || commitObj.created || new Date().toISOString()
        }
      };
    });

    const commits: ApiCommit[] = commitsData.map((c: any) => {
      const commitObj = c.commit || {};
      return {
        sha: c.sha || c.id || '',
        message: commitObj.message ? commitObj.message.split('\n')[0] : 'No commit message',
        author: commitObj.author?.name || commitObj.author_name || 'Unknown',
        date: commitObj.timestamp || commitObj.created || new Date().toISOString()
      };
    });

    // Fetch file tree - Gitea uses /git/trees API endpoint
    let files: ApiFile[] = [];
    const encodedBranch = encodeURIComponent(defaultBranch);
    try {
      // Try the git/trees endpoint first (more complete)
      const treeResponse = await fetch(getApiBaseUrl(
        `repos/${encodedOwner}/${encodedRepo}/git/trees/${encodedBranch}`,
        baseUrl,
        new URLSearchParams({ recursive: '1' })
      )).catch(() => null);
      if (treeResponse && treeResponse.ok) {
        const treeData = await treeResponse.json();
        if (treeData.tree && Array.isArray(treeData.tree)) {
          files = treeData.tree
            .filter((item: any) => item.type === 'blob' || item.type === 'tree')
            .map((item: any) => ({
              name: item.path.split('/').pop() || item.path,
              path: item.path,
              type: item.type === 'tree' ? 'dir' : 'file',
              size: item.size
            }));
        }
      } else {
        // Fallback to contents endpoint (only root directory)
        const contentsResponse = await fetch(getApiBaseUrl(
          `repos/${encodedOwner}/${encodedRepo}/contents`,
          baseUrl,
          new URLSearchParams({ ref: encodedBranch })
        )).catch(() => null);
        if (contentsResponse && contentsResponse.ok) {
          const contentsData = await contentsResponse.json();
          if (Array.isArray(contentsData)) {
            files = contentsData.map((item: any) => ({
              name: item.name,
              path: item.path || item.name,
              type: item.type === 'dir' ? 'dir' : 'file',
              size: item.size
            }));
          }
        }
      }
    } catch (error) {
      logger.warn({ error, owner, repo }, 'Failed to fetch Gitea file tree');
    }

    // Try to fetch README (prioritize .adoc over .md)
    // First try root directory (most common case)
    let readme: { path: string; content: string; format: 'markdown' | 'asciidoc' } | undefined;
    const readmeFiles = ['README.adoc', 'README.md', 'README.rst', 'README.txt'];
    for (const readmeFile of readmeFiles) {
      try {
        const encodedReadmeFile = encodeURIComponent(readmeFile);
        const fileResponse = await fetch(getApiBaseUrl(
          `repos/${encodedOwner}/${encodedRepo}/contents/${encodedReadmeFile}`,
          baseUrl,
          new URLSearchParams({ ref: defaultBranch })
        ));
        if (!fileResponse.ok) throw new Error('Not found');
        const fileData = await fileResponse.json();
        if (fileData.content) {
          // Gitea returns base64 encoded content
          const content = atob(fileData.content.replace(/\s/g, ''));
          readme = {
            path: readmeFile,
            content,
            format: readmeFile.toLowerCase().endsWith('.adoc') ? 'asciidoc' : 'markdown'
          };
          break; // Found a README, stop searching
        }
      } catch (error) {
        // Try next file
        continue;
      }
    }
    
    // If not found in root, search the file tree (case-insensitive)
    if (!readme && files.length > 0) {
      const readmePatterns = [/^readme\.adoc$/i, /^readme\.md$/i, /^readme\.rst$/i, /^readme\.txt$/i, /^readme$/i];
      let readmePath: string | null = null;
      for (const file of files) {
        if (file.type === 'file') {
          const fileName = file.name;
          for (const pattern of readmePatterns) {
            if (pattern.test(fileName)) {
              readmePath = file.path;
              break;
            }
          }
          if (readmePath) break;
        }
      }
      
      // If found in tree, fetch it
      if (readmePath) {
        try {
          // URL-encode the file path segments
          const encodedReadmePath = readmePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
          const fileResponse = await fetch(getApiBaseUrl(
            `repos/${encodedOwner}/${encodedRepo}/contents/${encodedReadmePath}`,
            baseUrl,
            new URLSearchParams({ ref: encodedBranch })
          ));
          if (!fileResponse.ok) throw new Error('Not found');
          const fileData = await fileResponse.json();
          if (fileData.content) {
            // Gitea returns base64 encoded content
            const content = atob(fileData.content.replace(/\s/g, ''));
            const format = readmePath.toLowerCase().endsWith('.adoc') ? 'asciidoc' : 'markdown';
            readme = {
              path: readmePath,
              content,
              format
            };
          }
        } catch (error) {
          logger.warn({ error, readmePath, owner, repo }, 'Failed to fetch README from tree path');
        }
      }
    }

    return {
      name: repoData.name || repoData.full_name?.split('/').pop() || repo,
      description: repoData.description,
      url: repoData.html_url || repoData.clone_url || `${baseUrl.replace('/api/v1', '')}/${owner}/${repo}`,
      defaultBranch: repoData.default_branch || defaultBranch,
      branches,
      commits,
      files,
      readme,
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
