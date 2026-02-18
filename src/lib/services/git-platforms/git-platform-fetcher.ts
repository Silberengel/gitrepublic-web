/**
 * Git Platform Fetcher Service
 * 
 * Fetches issues, pull requests, and comments from external git platforms
 * (GitHub, GitLab, Gitea, Codeberg, Forgejo, OneDev, custom)
 * for display in the universal dashboard.
 */

import logger from '../logger.js';
import type { MessagingPreferences } from '../messaging/preferences-storage.js';
import { getPreferences } from '../messaging/preferences-storage.js';

type GitPlatform = 'github' | 'gitlab' | 'gitea' | 'codeberg' | 'forgejo' | 'onedev' | 'custom';

interface GitPlatformConfig {
  baseUrl: string;
  issuesPath: string;
  pullsPath: string;
  commentsPath: string;
  authHeader: 'Bearer' | 'token';
  customHeaders?: Record<string, string>;
}

interface ExternalIssue {
  id: string | number;
  number?: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  created_at: string;
  updated_at: string;
  user: {
    login?: string;
    username?: string;
    avatar_url?: string;
  };
  html_url: string;
  comments_url?: string;
  comments_count?: number;
  labels?: Array<{ name: string; color?: string }>;
  platform: GitPlatform;
  owner: string;
  repo: string;
  apiUrl?: string;
}

interface ExternalPullRequest extends ExternalIssue {
  head?: {
    ref: string;
    sha: string;
  };
  base?: {
    ref: string;
    sha: string;
  };
  merged_at?: string | null;
  mergeable?: boolean;
}

interface ExternalComment {
  id: string | number;
  body: string;
  created_at: string;
  updated_at: string;
  user: {
    login?: string;
    username?: string;
    avatar_url?: string;
  };
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
}

// Platform configurations
const GIT_PLATFORM_CONFIGS: Record<string, Omit<GitPlatformConfig, 'baseUrl'>> = {
  github: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    commentsPath: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
    authHeader: 'Bearer',
    customHeaders: { 'Accept': 'application/vnd.github.v3+json' }
  },
  gitlab: {
    issuesPath: '/projects/{owner}%2F{repo}/issues',
    pullsPath: '/projects/{owner}%2F{repo}/merge_requests',
    commentsPath: '/projects/{owner}%2F{repo}/issues/{issue_id}/notes',
    authHeader: 'Bearer'
  },
  gitea: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    commentsPath: '/repos/{owner}/{repo}/issues/{issue_index}/comments',
    authHeader: 'token'
  },
  codeberg: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    commentsPath: '/repos/{owner}/{repo}/issues/{issue_index}/comments',
    authHeader: 'token'
  },
  forgejo: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    commentsPath: '/repos/{owner}/{repo}/issues/{issue_index}/comments',
    authHeader: 'token'
  },
  onedev: {
    issuesPath: '/{owner}/{repo}/issues',
    pullsPath: '/{owner}/{repo}/pull-requests',
    commentsPath: '/{owner}/{repo}/issues/{issue_id}/comments',
    authHeader: 'Bearer'
  },
  custom: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    commentsPath: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
    authHeader: 'Bearer'
  }
};

function getGitPlatformConfig(
  platform: GitPlatform,
  customApiUrl?: string
): GitPlatformConfig {
  if (platform === 'onedev') {
    if (!customApiUrl) {
      throw new Error('OneDev requires apiUrl to be provided');
    }
    return {
      ...GIT_PLATFORM_CONFIGS.onedev,
      baseUrl: customApiUrl
    };
  }

  if (platform === 'gitea' || platform === 'forgejo') {
    const config = GIT_PLATFORM_CONFIGS[platform];
    const baseUrls: Record<string, string> = {
      gitea: customApiUrl || 'https://codeberg.org/api/v1',
      forgejo: customApiUrl || 'https://forgejo.org/api/v1'
    };
    return {
      ...config,
      baseUrl: baseUrls[platform]
    };
  }

  if (platform === 'custom') {
    if (!customApiUrl) {
      throw new Error('Custom platform requires apiUrl');
    }
    return {
      ...GIT_PLATFORM_CONFIGS.custom,
      baseUrl: customApiUrl
    };
  }

  if (customApiUrl) {
    const config = GIT_PLATFORM_CONFIGS[platform];
    return {
      ...config,
      baseUrl: customApiUrl
    };
  }

  const config = GIT_PLATFORM_CONFIGS[platform];
  const baseUrls: Record<string, string> = {
    github: 'https://api.github.com',
    gitlab: 'https://gitlab.com/api/v4',
    codeberg: 'https://codeberg.org/api/v1'
  };

  return {
    ...config,
    baseUrl: baseUrls[platform] || ''
  };
}

function buildUrl(
  config: GitPlatformConfig,
  path: string,
  owner: string,
  repo: string,
  platform: GitPlatform,
  params?: Record<string, string | number>
): string {
  let urlPath = path
    .replace('{owner}', encodeURIComponent(owner))
    .replace('{repo}', encodeURIComponent(repo));

  if (platform === 'gitlab') {
    // GitLab uses URL-encoded owner/repo
    urlPath = path.replace('{owner}%2F{repo}', encodeURIComponent(`${owner}/${repo}`));
  }

  if (platform === 'onedev') {
    // OneDev uses project-path format: /api/projects/{project-path}/issues
    const projectPath = repo ? `${owner}/${repo}` : owner;
    urlPath = path.replace('{owner}/{repo}', encodeURIComponent(projectPath));
    // OneDev paths are relative to /api/projects/ (baseUrl already includes /api/projects)
    // But we need to add it here since path is relative
    if (!urlPath.startsWith('/api/projects')) {
      urlPath = `/api/projects${urlPath}`;
    }
  }

  // Replace path parameters
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      urlPath = urlPath.replace(`{${key}}`, String(value));
    }
  }

  const url = `${config.baseUrl}${urlPath}`;
  const searchParams = new URLSearchParams();
  searchParams.set('state', 'all'); // Get both open and closed
  searchParams.set('per_page', '50'); // Limit results
  searchParams.set('sort', 'updated');
  searchParams.set('direction', 'desc');

  return `${url}?${searchParams.toString()}`;
}

function buildAuthHeader(config: GitPlatformConfig, token: string): string {
  return config.authHeader === 'Bearer' ? `Bearer ${token}` : `token ${token}`;
}

async function fetchFromPlatform<T>(
  url: string,
  headers: Record<string, string>,
  platform: string
): Promise<T[]> {
  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return []; // Repository or resource not found
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`${platform} API error: ${error.message || response.statusText}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [data];
  } catch (error) {
    logger.error({ error, url: url.slice(0, 100) + '...', platform }, 'Failed to fetch from git platform');
    return [];
  }
}

function normalizeIssue(
  raw: any,
  platform: GitPlatform,
  owner: string,
  repo: string,
  apiUrl?: string
): ExternalIssue {
  // GitHub format
  if (raw.number !== undefined) {
    return {
      id: raw.id || raw.number,
      number: raw.number,
      title: raw.title || '',
      body: raw.body || '',
      state: raw.state === 'closed' ? 'closed' : 'open',
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || '',
      user: {
        login: raw.user?.login,
        avatar_url: raw.user?.avatar_url
      },
      html_url: raw.html_url || '',
      comments_url: raw.comments_url,
      comments_count: raw.comments,
      labels: raw.labels?.map((l: any) => ({ name: l.name, color: l.color })),
      platform,
      owner,
      repo,
      apiUrl
    };
  }

  // GitLab format
  if (raw.iid !== undefined) {
    const baseUrl = apiUrl || (platform === 'gitlab' ? 'https://gitlab.com' : '');
    return {
      id: raw.id || raw.iid,
      number: raw.iid,
      title: raw.title || '',
      body: raw.description || '',
      state: raw.state === 'closed' ? 'closed' : 'open',
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || '',
      user: {
        username: raw.author?.username,
        avatar_url: raw.author?.avatar_url
      },
      html_url: raw.web_url || `${baseUrl}/${owner}/${repo}/-/issues/${raw.iid}`,
      comments_count: raw.user_notes_count,
      labels: raw.labels?.map((l: string) => ({ name: l })),
      platform,
      owner,
      repo,
      apiUrl
    };
  }

  // Gitea/Codeberg/Forgejo format
  if (raw.index !== undefined) {
    const baseUrl = apiUrl || (platform === 'codeberg' ? 'https://codeberg.org' : '');
    return {
      id: raw.id || raw.index,
      number: raw.index,
      title: raw.title || '',
      body: raw.body || '',
      state: raw.state === 'closed' ? 'closed' : 'open',
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || '',
      user: {
        username: raw.user?.username || raw.poster?.username,
        avatar_url: raw.user?.avatar_url || raw.poster?.avatar_url
      },
      html_url: raw.html_url || `${baseUrl}/${owner}/${repo}/issues/${raw.index}`,
      comments_count: raw.comments,
      labels: raw.labels?.map((l: any) => ({ name: typeof l === 'string' ? l : l.name })),
      platform,
      owner,
      repo,
      apiUrl
    };
  }

  // OneDev format
  if (platform === 'onedev') {
    const baseUrl = apiUrl || '';
    return {
      id: raw.id || raw.number,
      number: raw.number,
      title: raw.title || '',
      body: raw.description || '',
      state: raw.state === 'closed' ? 'closed' : 'open',
      created_at: raw.submitDate || '',
      updated_at: raw.updateDate || '',
      user: {
        username: raw.submitter?.name,
        avatar_url: raw.submitter?.avatarUrl
      },
      html_url: raw.url || `${baseUrl}/${owner}/${repo}/issues/${raw.number}`,
      platform,
      owner,
      repo,
      apiUrl
    };
  }

  // Fallback
  return {
    id: raw.id || raw.number || 0,
    number: raw.number,
    title: raw.title || '',
    body: raw.body || raw.description || '',
    state: 'open',
    created_at: raw.created_at || '',
    updated_at: raw.updated_at || '',
    user: {},
    html_url: raw.html_url || raw.web_url || '',
    platform,
    owner,
    repo,
    apiUrl
  };
}

function normalizePullRequest(
  raw: any,
  platform: GitPlatform,
  owner: string,
  repo: string,
  apiUrl?: string
): ExternalPullRequest {
  const issue = normalizeIssue(raw, platform, owner, repo, apiUrl);

  // GitHub format
  if (raw.head && raw.base) {
    return {
      ...issue,
      state: raw.merged ? 'merged' : (raw.state === 'closed' ? 'closed' : 'open'),
      head: {
        ref: raw.head.ref,
        sha: raw.head.sha
      },
      base: {
        ref: raw.base.ref,
        sha: raw.base.sha
      },
      merged_at: raw.merged_at,
      mergeable: raw.mergeable
    };
  }

  // GitLab format
  if (raw.source_branch && raw.target_branch) {
    return {
      ...issue,
      state: raw.state === 'merged' ? 'merged' : (raw.state === 'closed' ? 'closed' : 'open'),
      head: {
        ref: raw.source_branch,
        sha: raw.sha || ''
      },
      base: {
        ref: raw.target_branch,
        sha: ''
      },
      merged_at: raw.merged_at
    };
  }

  // Gitea/Codeberg/Forgejo format
  if (raw.head && typeof raw.head === 'object') {
    return {
      ...issue,
      state: raw.state === 'closed' ? 'closed' : 'open',
      head: {
        ref: raw.head.ref || raw.head.name || '',
        sha: raw.head.sha || ''
      },
      base: {
        ref: raw.base?.ref || raw.base?.name || '',
        sha: raw.base?.sha || ''
      }
    };
  }

  return issue as ExternalPullRequest;
}

/**
 * Fetch issues from a git platform
 */
async function fetchIssues(
  platform: GitPlatform,
  owner: string,
  repo: string,
  token: string,
  apiUrl?: string
): Promise<ExternalIssue[]> {
  try {
    const config = getGitPlatformConfig(platform, apiUrl);
    const url = buildUrl(config, config.issuesPath, owner, repo, platform);
    const headers: Record<string, string> = {
      'Authorization': buildAuthHeader(config, token),
      'Content-Type': 'application/json',
      'User-Agent': 'GitRepublic',
      ...(config.customHeaders || {})
    };

    const rawIssues = await fetchFromPlatform<any>(url, headers, platform);
    return rawIssues
      .filter((issue: any) => !issue.pull_request) // Exclude PRs (GitHub returns PRs in issues endpoint)
      .map((issue: any) => normalizeIssue(issue, platform, owner, repo, apiUrl));
  } catch (error) {
    logger.error({ error, platform, owner, repo }, 'Failed to fetch issues');
    return [];
  }
}

/**
 * Fetch pull requests from a git platform
 */
async function fetchPullRequests(
  platform: GitPlatform,
  owner: string,
  repo: string,
  token: string,
  apiUrl?: string
): Promise<ExternalPullRequest[]> {
  try {
    const config = getGitPlatformConfig(platform, apiUrl);
    const url = buildUrl(config, config.pullsPath, owner, repo, platform);
    const headers: Record<string, string> = {
      'Authorization': buildAuthHeader(config, token),
      'Content-Type': 'application/json',
      'User-Agent': 'GitRepublic',
      ...(config.customHeaders || {})
    };

    const rawPRs = await fetchFromPlatform<any>(url, headers, platform);
    return rawPRs.map((pr: any) => normalizePullRequest(pr, platform, owner, repo, apiUrl));
  } catch (error) {
    logger.error({ error, platform, owner, repo }, 'Failed to fetch pull requests');
    return [];
  }
}

/**
 * Fetch comments for an issue or PR
 */
async function fetchComments(
  platform: GitPlatform,
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  apiUrl?: string
): Promise<ExternalComment[]> {
  try {
    const config = getGitPlatformConfig(platform, apiUrl);
    const commentsPath = config.commentsPath.replace('{issue_number}', String(issueNumber))
      .replace('{issue_id}', String(issueNumber))
      .replace('{issue_index}', String(issueNumber));
    const url = buildUrl(config, commentsPath, owner, repo, platform);
    const headers: Record<string, string> = {
      'Authorization': buildAuthHeader(config, token),
      'Content-Type': 'application/json',
      'User-Agent': 'GitRepublic',
      ...(config.customHeaders || {})
    };

    const rawComments = await fetchFromPlatform<any>(url, headers, platform);
    return rawComments.map((comment: any) => ({
      id: comment.id,
      body: comment.body || comment.note || '',
      created_at: comment.created_at || '',
      updated_at: comment.updated_at || '',
      user: {
        login: comment.user?.login || comment.author?.username,
        username: comment.user?.username || comment.author?.username,
        avatar_url: comment.user?.avatar_url || comment.author?.avatar_url
      },
      html_url: comment.html_url || comment.url || '',
      issue_url: comment.issue_url,
      pull_request_url: comment.pull_request_url
    }));
  } catch (error) {
    logger.error({ error, platform, owner, repo, issueNumber }, 'Failed to fetch comments');
    return [];
  }
}

/**
 * Get all issues and PRs from user's configured git platforms
 */
export async function getAllExternalItems(
  userPubkeyHex: string
): Promise<{
  issues: ExternalIssue[];
  pullRequests: ExternalPullRequest[];
}> {
  const preferences = await getPreferences(userPubkeyHex);
  if (!preferences || !preferences.gitPlatforms || preferences.gitPlatforms.length === 0) {
    return { issues: [], pullRequests: [] };
  }

  const allIssues: ExternalIssue[] = [];
  const allPRs: ExternalPullRequest[] = [];

  // Fetch from all configured platforms in parallel
  const promises: Promise<void>[] = [];

  for (const gitPlatform of preferences.gitPlatforms) {
    if (!gitPlatform.owner || !gitPlatform.repo || !gitPlatform.token) {
      continue;
    }

    if (gitPlatform.platform === 'onedev' && !gitPlatform.apiUrl) {
      logger.warn({ platform: 'onedev' }, 'OneDev requires apiUrl');
      continue;
    }

    if (gitPlatform.platform === 'custom' && !gitPlatform.apiUrl) {
      logger.warn({ platform: 'custom' }, 'Custom platform requires apiUrl');
      continue;
    }

    promises.push(
      fetchIssues(
        gitPlatform.platform,
        gitPlatform.owner,
        gitPlatform.repo,
        gitPlatform.token,
        gitPlatform.apiUrl
      ).then(issues => {
        allIssues.push(...issues);
      }).catch(err => {
        logger.warn({ error: err, platform: gitPlatform.platform }, 'Failed to fetch issues');
      })
    );

    promises.push(
      fetchPullRequests(
        gitPlatform.platform,
        gitPlatform.owner,
        gitPlatform.repo,
        gitPlatform.token,
        gitPlatform.apiUrl
      ).then(prs => {
        allPRs.push(...prs);
      }).catch(err => {
        logger.warn({ error: err, platform: gitPlatform.platform }, 'Failed to fetch PRs');
      })
    );
  }

  await Promise.allSettled(promises);

  // Sort by updated_at descending
  allIssues.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  allPRs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return { issues: allIssues, pullRequests: allPRs };
}

export type { ExternalIssue, ExternalPullRequest, ExternalComment, GitPlatform };
