/**
 * Event forwarding service
 * Forwards Nostr events to messaging platforms (Telegram, SimpleX, Email, Git platforms)
 * Only for users with unlimited access and configured preferences
 */

import logger from '../logger.js';
import type { NostrEvent } from '../../types/nostr.js';
import { getCachedUserLevel } from '../security/user-level-cache.js';
import { KIND } from '../../types/nostr.js';

// Lazy import to avoid importing Node.js crypto in browser
let getPreferences: typeof import('./preferences-storage.js').getPreferences;
async function getPreferencesLazy() {
  if (typeof window !== 'undefined') {
    // Browser environment - event forwarding should be done server-side
    return null;
  }
  if (!getPreferences) {
    const module = await import('./preferences-storage.js');
    getPreferences = module.getPreferences;
  }
  return getPreferences;
}

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface MessagingConfig {
  telegram?: {
    botToken: string;
    enabled: boolean;
  };
  simplex?: {
    apiUrl: string;
    apiKey: string;
    enabled: boolean;
  };
  email?: {
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    fromAddress: string;
    fromName: string;
    enabled: boolean;
  };
  gitPlatforms?: {
    enabled: boolean;
  };
}

type GitPlatform = 'github' | 'gitlab' | 'gitea' | 'codeberg' | 'forgejo' | 'onedev' | 'custom';

interface GitPlatformConfig {
  baseUrl: string;
  issuesPath: string;
  pullsPath: string;
  authHeader: 'Bearer' | 'token';
  usesDescription: boolean; // true for GitLab/OneDev, false for GitHub/Gitea/etc
  usesSourceTargetBranch: boolean; // true for GitLab/OneDev, false for GitHub/Gitea/etc
  customHeaders?: Record<string, string>;
}

interface EventContent {
  title: string;
  body: string;
  fullBody: string;
}

// ============================================================================
// Constants
// ============================================================================

const KIND_NAMES: Record<number, string> = {
  1621: 'Issue',
  1618: 'Pull Request',
  9802: 'Highlight',
  30617: 'Repository Announcement',
  1641: 'Ownership Transfer',
  24: 'Public Message'
};

const GIT_PLATFORM_CONFIGS: Record<string, Omit<GitPlatformConfig, 'baseUrl'>> = {
  github: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    authHeader: 'Bearer',
    usesDescription: false,
    usesSourceTargetBranch: false,
    customHeaders: { 'Accept': 'application/vnd.github.v3+json' }
  },
  gitlab: {
    issuesPath: '/projects/{owner}%2F{repo}/issues',
    pullsPath: '/projects/{owner}%2F{repo}/merge_requests',
    authHeader: 'Bearer',
    usesDescription: true,
    usesSourceTargetBranch: true
  },
  gitea: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    authHeader: 'token',
    usesDescription: false,
    usesSourceTargetBranch: false
  },
  codeberg: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    authHeader: 'token',
    usesDescription: false,
    usesSourceTargetBranch: false
  },
  forgejo: {
    issuesPath: '/repos/{owner}/{repo}/issues',
    pullsPath: '/repos/{owner}/{repo}/pulls',
    authHeader: 'token',
    usesDescription: false,
    usesSourceTargetBranch: false
  },
  onedev: {
    issuesPath: '/{owner}/{repo}/issues', // Path relative to /api/projects/ (added in buildGitPlatformUrl)
    pullsPath: '/{owner}/{repo}/pull-requests', // Path relative to /api/projects/ (added in buildGitPlatformUrl)
    authHeader: 'Bearer',
    usesDescription: true,
    usesSourceTargetBranch: true
  }
};

const MESSAGING_CONFIG: MessagingConfig = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    enabled: process.env.TELEGRAM_ENABLED === 'true'
  },
  simplex: {
    apiUrl: process.env.SIMPLEX_API_URL || '',
    apiKey: process.env.SIMPLEX_API_KEY || '',
    enabled: process.env.SIMPLEX_ENABLED === 'true'
  },
  email: {
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || '',
    smtpPassword: process.env.SMTP_PASSWORD || '',
    fromAddress: process.env.SMTP_FROM_ADDRESS || '',
    fromName: process.env.SMTP_FROM_NAME || 'GitRepublic',
    enabled: process.env.EMAIL_ENABLED === 'true'
  },
  gitPlatforms: {
    enabled: process.env.GIT_PLATFORMS_ENABLED === 'true'
  }
};

// ============================================================================
// Helper Functions
// ============================================================================

function formatEventMessage(event: NostrEvent, userPubkeyHex: string): string {
  const kindName = KIND_NAMES[event.kind] || `Event ${event.kind}`;
  const userShort = userPubkeyHex.slice(0, 16) + '...';
  
  // Special formatting for public messages (kind 24)
  if (event.kind === KIND.PUBLIC_MESSAGE) {
    const recipients = event.tags
      .filter(tag => tag[0] === 'p' && tag[1])
      .map(tag => tag[1].slice(0, 16) + '...');
    
    let message = `💬 Public Message from ${userShort}`;
    if (recipients.length > 0) {
      message += ` to ${recipients.join(', ')}`;
    }
    message += '\n\n';
    message += event.content || 'No content';
    return message;
  }
  
  let message = `🔔 ${kindName} published by ${userShort}\n\n`;
  
  if (event.content) {
    const content = event.content.length > 500 
      ? event.content.slice(0, 500) + '...'
      : event.content;
    message += content;
  } else {
    message += 'No content';
  }

  return message;
}

function extractEventContent(event: NostrEvent): EventContent {
  const titleTag = event.tags.find(t => t[0] === 'title' || t[0] === 'subject');
  const title = titleTag?.[1] || (event.content ? event.content.split('\n')[0].slice(0, 100) : 'Untitled');
  const body = event.content || '';
  const metadata = `\n\n---\n*Forwarded from GitRepublic (Nostr)*\n*Event ID: ${event.id}*\n*Kind: ${event.kind}*`;
  const fullBody = body + metadata;

  return { title, body, fullBody };
}

function getGitPlatformConfig(
  platform: GitPlatform,
  customApiUrl?: string
): GitPlatformConfig {
  if (platform === 'onedev') {
    if (!customApiUrl) {
      throw new Error('OneDev requires apiUrl to be provided (self-hosted instance)');
    }
    return {
      ...GIT_PLATFORM_CONFIGS.onedev,
      baseUrl: customApiUrl
    };
  }

  // Gitea and Forgejo are self-hosted - require apiUrl if not using Codeberg/Forgejo.org defaults
  if (platform === 'gitea' || platform === 'forgejo') {
    const config = GIT_PLATFORM_CONFIGS[platform];
    if (!config) {
      throw new Error(`Unsupported Git platform: ${platform}`);
    }
    
    // Use custom API URL if provided, otherwise use default hosted instance
    const baseUrls: Record<string, string> = {
      gitea: customApiUrl || 'https://codeberg.org/api/v1', // Codeberg uses Gitea
      forgejo: customApiUrl || 'https://forgejo.org/api/v1' // Forgejo.org hosted instance
    };
    
    return {
      ...config,
      baseUrl: baseUrls[platform]
    };
  }

  // Custom platform - assume Gitea-compatible format
  if (platform === 'custom') {
    if (!customApiUrl) {
      throw new Error('Custom platform requires apiUrl to be provided');
    }
    return {
      baseUrl: customApiUrl,
      issuesPath: '/repos/{owner}/{repo}/issues',
      pullsPath: '/repos/{owner}/{repo}/pulls',
      authHeader: 'Bearer',
      usesDescription: false,
      usesSourceTargetBranch: false
    };
  }

  // If customApiUrl is provided for other platforms, use it but keep platform config
  if (customApiUrl) {
    const config = GIT_PLATFORM_CONFIGS[platform];
    if (!config) {
      throw new Error(`Unsupported Git platform: ${platform}`);
    }
    return {
      ...config,
      baseUrl: customApiUrl
    };
  }

  const config = GIT_PLATFORM_CONFIGS[platform];
  if (!config) {
    throw new Error(`Unsupported Git platform: ${platform}`);
  }

  // Get baseUrl from platform config or use default
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

function buildGitPlatformUrl(
  config: GitPlatformConfig,
  owner: string,
  repo: string,
  pathType: 'issues' | 'pulls',
  platform: GitPlatform
): string {
  if (platform === 'onedev') {
    // OneDev uses project-path format: /api/projects/{project-path}/issues
    const projectPath = repo ? `${owner}/${repo}` : owner;
    const path = pathType === 'issues' ? config.issuesPath : config.pullsPath;
    // Path already contains {owner}/{repo}, just replace them
    const urlPath = path
      .replace('{owner}', encodeURIComponent(owner))
      .replace('{repo}', encodeURIComponent(repo));
    return `${config.baseUrl}/api/projects${urlPath}`;
  }

  const path = pathType === 'issues' ? config.issuesPath : config.pullsPath;
  const urlPath = path
    .replace('{owner}', encodeURIComponent(owner))
    .replace('{repo}', encodeURIComponent(repo));
  
  return `${config.baseUrl}${urlPath}`;
}

function buildAuthHeader(config: GitPlatformConfig, token: string): string {
  return config.authHeader === 'Bearer' ? `Bearer ${token}` : `token ${token}`;
}

function buildIssuePayload(
  content: EventContent,
  config: GitPlatformConfig,
  prefix?: string
): Record<string, unknown> {
  const title = prefix ? `${prefix}${content.title}` : content.title;
  const payload: Record<string, unknown> = { title };

  if (config.usesDescription) {
    payload.description = content.fullBody;
  } else {
    payload.body = content.fullBody;
  }

  return payload;
}

function buildPullRequestPayload(
  content: EventContent,
  config: GitPlatformConfig,
  headBranch: string,
  baseBranch: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: content.title
  };

  if (config.usesDescription) {
    payload.description = content.fullBody;
  } else {
    payload.body = content.fullBody;
  }

  if (config.usesSourceTargetBranch) {
    payload.source_branch = headBranch;
    payload.target_branch = baseBranch;
  } else {
    payload.head = headBranch;
    payload.base = baseBranch;
  }

  return payload;
}

async function makeGitPlatformRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  platform: string
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(`${platform} API error: ${error.message || response.statusText}`);
  }
}

// ============================================================================
// Platform Forwarding Functions
// ============================================================================

async function sendToTelegram(message: string, chatId: string): Promise<void> {
  if (!MESSAGING_CONFIG.telegram?.enabled || !MESSAGING_CONFIG.telegram?.botToken) {
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${MESSAGING_CONFIG.telegram.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Telegram API error: ${error.description || response.statusText}`);
    }
  } catch (error) {
    logger.error({ error, chatId: chatId.slice(0, 10) + '...' }, 'Failed to send to Telegram');
    throw error;
  }
}

async function sendToSimpleX(message: string, contactId: string): Promise<void> {
  if (!MESSAGING_CONFIG.simplex?.enabled || !MESSAGING_CONFIG.simplex?.apiUrl) {
    return;
  }

  try {
    const response = await fetch(`${MESSAGING_CONFIG.simplex.apiUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MESSAGING_CONFIG.simplex.apiKey}`
      },
      body: JSON.stringify({
        contact_id: contactId,
        message: message
      })
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`SimpleX API error: ${error}`);
    }
  } catch (error) {
    logger.error({ error, contactId: contactId.slice(0, 10) + '...' }, 'Failed to send to SimpleX');
    throw error;
  }
}

async function sendEmail(
  subject: string,
  message: string,
  to: string[],
  cc?: string[]
): Promise<void> {
  if (!MESSAGING_CONFIG.email?.enabled || !MESSAGING_CONFIG.email?.smtpHost) {
    return;
  }

  try {
    const smtpUrl = process.env.SMTP_API_URL;
    
    if (smtpUrl) {
      // Use SMTP API if provided
      const response = await fetch(smtpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SMTP_API_KEY || ''}`
        },
        body: JSON.stringify({
          from: MESSAGING_CONFIG.email.fromAddress,
          to,
          cc: cc || [],
          subject,
          text: message
        })
      });

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error');
        throw new Error(`Email API error: ${error}`);
      }
    } else {
      // Direct SMTP using nodemailer
      try {
        const nodemailer = await import('nodemailer');
        const { createTransport } = nodemailer;
        
        const transporter = createTransport({
          host: MESSAGING_CONFIG.email.smtpHost,
          port: MESSAGING_CONFIG.email.smtpPort,
          secure: MESSAGING_CONFIG.email.smtpPort === 465,
          auth: {
            user: MESSAGING_CONFIG.email.smtpUser,
            pass: MESSAGING_CONFIG.email.smtpPassword
          }
        });

        await transporter.sendMail({
          from: `"${MESSAGING_CONFIG.email.fromName}" <${MESSAGING_CONFIG.email.fromAddress}>`,
          to: to.join(', '),
          cc: cc && cc.length > 0 ? cc.join(', ') : undefined,
          subject,
          text: message
        });
      } catch (importError) {
        throw new Error(
          'Email sending requires either SMTP_API_URL or nodemailer package. ' +
          'Install with: npm install nodemailer'
        );
      }
    }
  } catch (error) {
    logger.error({ 
      error, 
      toCount: to.length,
      ccCount: cc?.length || 0
    }, 'Failed to send email');
    throw error;
  }
}

async function forwardToGitPlatform(
  event: NostrEvent,
  platform: GitPlatform,
  owner: string,
  repo: string,
  token: string,
  customApiUrl?: string
): Promise<void> {
  if (!MESSAGING_CONFIG.gitPlatforms?.enabled) {
    return;
  }

  try {
    const config = getGitPlatformConfig(platform, customApiUrl);
    const content = extractEventContent(event);
    
    const authHeader = buildAuthHeader(config, token);
    const headers: Record<string, string> = {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'User-Agent': 'GitRepublic',
      ...(config.customHeaders || {})
    };

    // Handle different event kinds
    if (event.kind === KIND.ISSUE) {
      const issuesUrl = buildGitPlatformUrl(config, owner, repo, 'issues', platform);
      const payload = buildIssuePayload(content, config);
      await makeGitPlatformRequest(issuesUrl, 'POST', headers, payload, platform);
      
    } else if (event.kind === KIND.PULL_REQUEST) {
      const headTag = event.tags.find(t => t[0] === 'head');
      const baseTag = event.tags.find(t => t[0] === 'base');
      
      if (headTag?.[1] && baseTag?.[1]) {
        // Create actual PR with branch info
        const pullsUrl = buildGitPlatformUrl(config, owner, repo, 'pulls', platform);
        const payload = buildPullRequestPayload(content, config, headTag[1], baseTag[1]);
        await makeGitPlatformRequest(pullsUrl, 'POST', headers, payload, platform);
      } else {
        // No branch info, create issue with PR label
        const issuesUrl = buildGitPlatformUrl(config, owner, repo, 'issues', platform);
        const payload = buildIssuePayload(content, config, '[PR] ');
        if (Array.isArray(payload.labels)) {
          payload.labels.push('pull-request');
        } else {
          payload.labels = ['pull-request'];
        }
        await makeGitPlatformRequest(issuesUrl, 'POST', headers, payload, platform);
      }
      
    } else {
      // Other event types: create issue with event kind label
      const issuesUrl = buildGitPlatformUrl(config, owner, repo, 'issues', platform);
      const payload = buildIssuePayload(content, config, `[Event ${event.kind}] `);
      payload.labels = [`nostr-kind-${event.kind}`];
      await makeGitPlatformRequest(issuesUrl, 'POST', headers, payload, platform);
    }
    
  } catch (error) {
    logger.error({ 
      error, 
      platform,
      owner,
      repo: repo.slice(0, 10) + '...',
      eventKind: event.kind
    }, `Failed to forward to ${platform}`);
    throw error;
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Forward event to configured messaging platforms
 * Only forwards if:
 * - User has unlimited access
 * - User has preferences configured and enabled
 * - Event kind is in notifyOn list (if specified)
 */
export async function forwardEventIfEnabled(
  event: NostrEvent,
  userPubkeyHex: string
): Promise<void> {
  try {
    // Early returns for eligibility checks
    const cached = getCachedUserLevel(userPubkeyHex);
    if (!cached || cached.level !== 'unlimited') {
      return;
    }

    const getPreferencesFn = await getPreferencesLazy();
    if (!getPreferencesFn) {
      // Browser environment - forwarding should be done server-side via API
      return;
    }
    const preferences = await getPreferencesFn(userPubkeyHex);
    if (!preferences || !preferences.enabled) {
      return;
    }

    if (preferences.notifyOn && preferences.notifyOn.length > 0) {
      if (!preferences.notifyOn.includes(event.kind.toString())) {
        return;
      }
    }

    // Prepare message content
    const message = formatEventMessage(event, userPubkeyHex);
    const kindName = KIND_NAMES[event.kind] || `Event ${event.kind}`;
    const subject = `GitRepublic: ${kindName} Notification`;

    // Collect all forwarding promises
    const promises: Promise<void>[] = [];

    // Messaging platforms
    if (preferences.telegram) {
      promises.push(
        sendToTelegram(message, preferences.telegram)
          .catch(err => logger.warn({ error: err }, 'Telegram forwarding failed'))
      );
    }

    if (preferences.simplex) {
      promises.push(
        sendToSimpleX(message, preferences.simplex)
          .catch(err => logger.warn({ error: err }, 'SimpleX forwarding failed'))
      );
    }

    if (preferences.email?.to && preferences.email.to.length > 0) {
      promises.push(
        sendEmail(subject, message, preferences.email.to, preferences.email.cc)
          .catch(err => logger.warn({ error: err }, 'Email forwarding failed'))
      );
    }

    // Git platforms
    if (preferences.gitPlatforms && preferences.gitPlatforms.length > 0) {
      for (const gitPlatform of preferences.gitPlatforms) {
        if (!gitPlatform.owner || !gitPlatform.repo || !gitPlatform.token) {
          continue;
        }
        
        // Validate self-hosted platforms that require apiUrl
        if (gitPlatform.platform === 'onedev' && !gitPlatform.apiUrl) {
          logger.warn({ platform: 'onedev' }, 'OneDev requires apiUrl to be provided');
          continue;
        }
        if (gitPlatform.platform === 'custom' && !gitPlatform.apiUrl) {
          logger.warn({ platform: 'custom' }, 'Custom platform requires apiUrl to be provided');
          continue;
        }
        
        promises.push(
          forwardToGitPlatform(
            event,
            gitPlatform.platform,
            gitPlatform.owner,
            gitPlatform.repo,
            gitPlatform.token,
            gitPlatform.apiUrl
          )
            .catch(err => logger.warn({ error: err, platform: gitPlatform.platform }, 'Git platform forwarding failed'))
        );
      }
    }

    // Execute all forwarding in parallel
    await Promise.allSettled(promises);

    logger.debug({ 
      eventId: event.id.slice(0, 16) + '...',
      userPubkeyHex: userPubkeyHex.slice(0, 16) + '...',
      platforms: Object.keys(preferences).filter(k => k !== 'enabled' && k !== 'notifyOn' && preferences[k as keyof typeof preferences])
    }, 'Forwarded event to messaging platforms');
    
  } catch (error) {
    // Log but don't throw - forwarding failures shouldn't break event publishing
    logger.error({ 
      error, 
      eventId: event.id?.slice(0, 16) + '...',
      userPubkeyHex: userPubkeyHex.slice(0, 16) + '...'
    }, 'Failed to forward event to messaging platforms');
  }
}
