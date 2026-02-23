/**
 * API endpoint for checking server configuration status
 * Returns configuration status without exposing sensitive values
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  // Helper to check if env var is set
  const isSet = (key: string): boolean => {
    return typeof process !== 'undefined' && !!process.env?.[key];
  };

  // Helper to get env var with default
  const getEnv = (key: string, defaultValue: string): string => {
    return typeof process !== 'undefined' && process.env?.[key]
      ? process.env[key]!
      : defaultValue;
  };

  // Helper to get env var as number with default
  const getEnvNum = (key: string, defaultValue: number): number => {
    if (typeof process === 'undefined' || !process.env?.[key]) {
      return defaultValue;
    }
    const parsed = parseInt(process.env[key]!, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  };

  // Helper to get env var as boolean
  const getEnvBool = (key: string, defaultValue: boolean): boolean => {
    if (typeof process === 'undefined' || !process.env?.[key]) {
      return defaultValue;
    }
    return process.env[key] === 'true';
  };

  return json({
    github: {
      tokenConfigured: isSet('GITHUB_TOKEN'),
    },
    git: {
      repoRoot: getEnv('GIT_REPO_ROOT', '/repos'),
      domain: getEnv('GIT_DOMAIN', 'localhost:6543'),
      defaultBranch: getEnv('DEFAULT_BRANCH', 'master'),
      operationTimeoutMs: getEnvNum('GIT_OPERATION_TIMEOUT_MS', 300000),
      cloneTimeoutMs: getEnvNum('GIT_CLONE_TIMEOUT_MS', 300000),
      allowForcePush: getEnvBool('ALLOW_FORCE_PUSH', false),
    },
    nostr: {
      relays: getEnv('NOSTR_RELAYS', '').split(',').filter(r => r.trim()).length > 0
        ? getEnv('NOSTR_RELAYS', '').split(',').map(r => r.trim()).filter(r => r.length > 0)
        : ['wss://theforest.nostr1.com', 'wss://nostr.land'],
      searchRelays: getEnv('NOSTR_SEARCH_RELAYS', '').split(',').filter(r => r.trim()).length > 0
        ? getEnv('NOSTR_SEARCH_RELAYS', '').split(',').map(r => r.trim()).filter(r => r.length > 0)
        : [],
      nip98AuthWindowSeconds: getEnvNum('NIP98_AUTH_WINDOW_SECONDS', 60),
    },
    tor: {
      enabled: isSet('TOR_SOCKS_PROXY') && getEnv('TOR_SOCKS_PROXY', '') !== '',
      socksProxy: getEnv('TOR_SOCKS_PROXY', '127.0.0.1:9050'),
      hostnameFile: getEnv('TOR_HOSTNAME_FILE', ''),
      onionAddress: getEnv('TOR_ONION_ADDRESS', ''),
    },
    security: {
      adminPubkeysConfigured: isSet('ADMIN_PUBKEYS'),
      auditLoggingEnabled: getEnvBool('AUDIT_LOGGING_ENABLED', true),
      auditLogFile: getEnv('AUDIT_LOG_FILE', ''),
      auditLogRetentionDays: getEnvNum('AUDIT_LOG_RETENTION_DAYS', 90),
      rateLimitEnabled: getEnvBool('RATE_LIMIT_ENABLED', true),
      rateLimitWindowMs: getEnvNum('RATE_LIMIT_WINDOW_MS', 60000),
    },
    resources: {
      maxReposPerUser: getEnvNum('MAX_REPOS_PER_USER', 100),
      maxDiskQuotaPerUser: getEnvNum('MAX_DISK_QUOTA_PER_USER', 10737418240), // 10GB
    },
    messaging: {
      encryptionKeyConfigured: isSet('MESSAGING_PREFS_ENCRYPTION_KEY'),
      saltEncryptionKeyConfigured: isSet('MESSAGING_SALT_ENCRYPTION_KEY'),
      lookupSecretConfigured: isSet('MESSAGING_LOOKUP_SECRET'),
    },
    enterprise: {
      enabled: getEnvBool('ENTERPRISE_MODE', false),
    },
    docker: {
      container: getEnvBool('DOCKER_CONTAINER', false),
    },
  });
};
