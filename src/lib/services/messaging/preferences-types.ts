/**
 * Types for messaging preferences
 * This file is separate from preferences-storage.server.ts to avoid bundling Node.js crypto in the browser
 */

export interface MessagingPreferences {
  telegram?: string; // Chat ID or username
  simplex?: string;  // Contact ID
  email?: {
    to: string[];    // To: email addresses
    cc?: string[];   // CC: email addresses (optional)
  };
  gitPlatforms?: Array<{
    platform: 'github' | 'gitlab' | 'gitea' | 'codeberg' | 'forgejo' | 'onedev' | 'custom';
    owner: string;   // Repository owner (username or org)
    repo: string;    // Repository name
    token: string;   // Personal access token (encrypted)
    apiUrl?: string; // Custom API URL (required for onedev and self-hosted platforms)
  }>;
  enabled: boolean;
  notifyOn?: string[]; // Event kinds to forward (e.g., ['1621', '1618'])
}
