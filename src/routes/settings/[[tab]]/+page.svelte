<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { settingsStore } from '$lib/services/settings-store.js';
  import { userStore } from '$lib/stores/user-store.js';
  import { fetchUserEmail, fetchUserName, fetchUserProfile, extractProfileData, getUserName, getUserEmail } from '$lib/utils/user-profile.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import ForwardingConfig from '$lib/components/ForwardingConfig.svelte';

  // Get tab from URL params
  const validTabs = ['general', 'git-setup', 'connections'] as const;
  type TabType = typeof validTabs[number];
  
  // Get initial tab from URL, default to 'general'
  const getTabFromUrl = () => {
    const tabParam = ($page.params as { tab?: string }).tab;
    if (tabParam && validTabs.includes(tabParam as TabType)) {
      return tabParam as TabType;
    }
    return 'general';
  };
  
  let activeTab = $state<TabType>(getTabFromUrl());

  let autoSave = $state(false);
  let userName = $state('');
  let userEmail = $state('');
  let theme = $state<'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black'>('gitrepublic-dark');
  let defaultBranch = $state('master');
  let loading = $state(false);
  let saving = $state(false);
  let loadingPresets = $state(false);
  let settingsLoaded = $state(false);
  let configStatus = $state<any>(null);
  let loadingConfig = $state(false);
  let expandedSections = $state<Set<string>>(new Set(['github', 'git']));

  // Preset values that will be used if user doesn't override
  let presetUserName = $state('');
  let presetUserEmail = $state('');

  // Update URL when tab changes
  function setActiveTab(tab: TabType) {
    activeTab = tab;
    goto(`/settings/${tab}`, { replaceState: true, noScroll: true });
  }

  async function loadSettings() {
    if (settingsLoaded) return; // Don't reload if already loaded
    loading = true;
    try {
      console.log('[SettingsPage] Loading settings from store...');
      const settings = await settingsStore.getSettings();
      console.log('[SettingsPage] Settings loaded:', settings);
      autoSave = settings.autoSave;
      userName = settings.userName;
      userEmail = settings.userEmail;
      theme = settings.theme;
      defaultBranch = settings.defaultBranch;
      settingsLoaded = true;
    } catch (err) {
      console.error('[SettingsPage] Failed to load settings:', err);
    } finally {
      loading = false;
    }
  }

  async function loadPresets() {
    // Get user's pubkey from store
    const currentUser = $userStore;
    if (!currentUser.userPubkeyHex) {
      // User not logged in, no presets available
      presetUserName = '';
      presetUserEmail = '';
      return;
    }

    loadingPresets = true;
    try {
      // Fetch profile from kind 0 event (cache or relays)
      const profileEvent = await fetchUserProfile(currentUser.userPubkeyHex, DEFAULT_NOSTR_RELAYS);
      const profile = extractProfileData(profileEvent);
      
      // Get preset values using the same fallback logic as the commit functions
      presetUserName = getUserName(profile, currentUser.userPubkeyHex, currentUser.userPubkey || undefined);
      presetUserEmail = getUserEmail(profile, currentUser.userPubkeyHex, currentUser.userPubkey || undefined);
    } catch (err) {
      console.warn('Failed to load presets from profile:', err);
      // Fallback to shortened npub values
      if (currentUser.userPubkey) {
        presetUserName = currentUser.userPubkey.substring(0, 20);
        presetUserEmail = `${currentUser.userPubkey.substring(0, 20)}@gitrepublic.web`;
      } else if (currentUser.userPubkeyHex) {
        const { nip19 } = await import('nostr-tools');
        const npub = nip19.npubEncode(currentUser.userPubkeyHex);
        presetUserName = npub.substring(0, 20);
        presetUserEmail = `${npub.substring(0, 20)}@gitrepublic.web`;
      } else {
        presetUserName = '';
        presetUserEmail = '';
      }
    } finally {
      loadingPresets = false;
    }
  }

  async function saveSettings() {
    saving = true;
    try {
      // Save empty string if user wants to use presets, otherwise save the custom value
      await settingsStore.updateSettings({
        autoSave,
        userName: userName.trim() || '', // Empty string means use preset
        userEmail: userEmail.trim() || '', // Empty string means use preset
        theme,
        defaultBranch: defaultBranch.trim() || 'master'
      });

      // Apply theme immediately
      applyTheme(theme);
      
      // Sync to localStorage for app.html flash prevention
      if (typeof window !== 'undefined') {
        localStorage.setItem('theme', theme);
        // Dispatch event to notify layout of theme change
        window.dispatchEvent(new CustomEvent('themeChanged', { 
          detail: { theme } 
        }));
      }

      // Show success message and optionally navigate back
      alert('Settings saved successfully!');
    } catch (err) {
      console.error('Failed to save settings:', err);
      alert('Failed to save settings. Please try again.');
    } finally {
      saving = false;
    }
  }

  function applyTheme(newTheme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black') {
    // Remove all theme attributes first
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-light');
    document.documentElement.removeAttribute('data-theme-black');
    
    // Apply the selected theme
    if (newTheme === 'gitrepublic-light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (newTheme === 'gitrepublic-dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (newTheme === 'gitrepublic-black') {
      document.documentElement.setAttribute('data-theme', 'black');
    }
  }

  function handleThemeChange(newTheme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black') {
    theme = newTheme;
    // Preview theme change immediately (don't save yet)
    applyTheme(newTheme);
  }

  function goBack() {
    // Use browser history to go back, fallback to dashboard if no history
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    } else {
      goto('/dashboard');
    }
  }

  async function loadConfigStatus() {
    loadingConfig = true;
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        configStatus = await response.json();
      }
    } catch (err) {
      console.error('Failed to load config status:', err);
    } finally {
      loadingConfig = false;
    }
  }

  // Load settings and presets on mount
  onMount(async () => {
    // Redirect to /settings/general if no tab is specified
    const tabParam = ($page.params as { tab?: string }).tab;
    if (!tabParam) {
      goto('/settings/general', { replaceState: true });
    }
    
    await loadSettings();
    await loadPresets();
    await loadConfigStatus();
  });

  // Sync activeTab with URL param when it changes
  $effect(() => {
    const tab = getTabFromUrl();
    if (tab !== activeTab) {
      activeTab = tab;
    }
  });
</script>

<div class="settings-page">
  <div class="settings-header">
    <h1>Settings</h1>
    <button class="back-button" onclick={goBack} aria-label="Back">
      <span>← Back</span>
    </button>
  </div>

  {#if loading && !settingsLoaded}
    <div class="loading">Loading settings...</div>
  {:else}
    <!-- Tabs -->
    <div class="tabs">
      <button 
        class="tab-button" 
        class:active={activeTab === 'general'}
        onclick={() => setActiveTab('general')}
      >
        General
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'git-setup'}
        onclick={() => setActiveTab('git-setup')}
      >
        Git Setup
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'connections'}
        onclick={() => setActiveTab('connections')}
      >
        Connections
      </button>
    </div>

    <div class="settings-content">
      <!-- General Tab -->
      {#if activeTab === 'general'}
        <div class="setting-group">
          <div class="setting-label">
            <span class="label-text">Theme</span>
          </div>
          <div class="theme-options">
            <button
              class="theme-option"
              class:active={theme === 'gitrepublic-light'}
              onclick={() => handleThemeChange('gitrepublic-light')}
            >
              <img src="/icons/sun.svg" alt="Light theme" class="theme-icon" />
              <span>Light</span>
            </button>
            <button
              class="theme-option"
              class:active={theme === 'gitrepublic-dark'}
              onclick={() => handleThemeChange('gitrepublic-dark')}
            >
              <img src="/icons/palette.svg" alt="Purple theme" class="theme-icon" />
              <span>Purple</span>
            </button>
            <button
              class="theme-option"
              class:active={theme === 'gitrepublic-black'}
              onclick={() => handleThemeChange('gitrepublic-black')}
            >
              <img src="/icons/moon.svg" alt="Black theme" class="theme-icon" />
              <span>Black</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- Git Setup Tab -->
      {#if activeTab === 'git-setup'}
        <!-- Auto-save Toggle -->
        <div class="setting-group">
          <label class="setting-label">
            <span class="label-text">Auto-save</span>
            <div class="toggle-container">
              <input
                type="checkbox"
                bind:checked={autoSave}
                class="toggle-input"
                id="auto-save-toggle"
              />
              <label for="auto-save-toggle" class="toggle-label">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </label>
          <p class="setting-description">
            When enabled, changes are automatically committed every 10 minutes if there are unsaved changes.
          </p>
        </div>

        <!-- User Name -->
        <div class="setting-group">
          <label class="setting-label" for="user-name">
            <span class="label-text">Git User Name</span>
          </label>
          <input
            type="text"
            id="user-name"
            bind:value={userName}
            placeholder={presetUserName || 'Enter your git user.name'}
            class="setting-input"
          />
          {#if presetUserName}
            <p class="setting-hint">
              {#if userName.trim()}
                Custom value saved. Default would be: {presetUserName}
              {:else}
                Will use: <strong>{presetUserName}</strong> (from your Nostr profile: display_name → name → shortened npub)
              {/if}
            </p>
          {/if}
          <p class="setting-description">
            Your name as it will appear in git commits. Leave empty to use the preset value from your Nostr profile.
          </p>
        </div>

        <!-- User Email -->
        <div class="setting-group">
          <label class="setting-label" for="user-email">
            <span class="label-text">Git User Email</span>
          </label>
          <input
            type="email"
            id="user-email"
            bind:value={userEmail}
            placeholder={presetUserEmail || 'Enter your git user.email'}
            class="setting-input"
          />
          {#if presetUserEmail}
            <p class="setting-hint">
              {#if userEmail.trim()}
                Custom value saved. Default would be: {presetUserEmail}
              {:else}
                Will use: <strong>{presetUserEmail}</strong> (from your Nostr profile: NIP-05 → shortenednpub@gitrepublic.web)
              {/if}
            </p>
          {/if}
          <p class="setting-description">
            Your email as it will appear in git commits. Leave empty to use the preset value from your Nostr profile.
          </p>
        </div>

        <!-- Default Branch -->
        <div class="setting-group">
          <label class="setting-label" for="default-branch">
            <span class="label-text">Default Branch Name</span>
          </label>
          <input
            type="text"
            id="default-branch"
            bind:value={defaultBranch}
            placeholder="master"
            class="setting-input"
          />
          <p class="setting-description">
            Default branch name to use when creating new repositories. This will be used as the base branch when creating the first branch in a new repo.
          </p>
        </div>
      {/if}

      <!-- Connections Tab -->
      {#if activeTab === 'connections'}
        <!-- Server Configuration Status -->
        <div class="setting-group">
          <h3 class="setting-section-title">Server Configuration</h3>
          <p class="setting-description">
            Environment variables and server settings. Configure these in your environment or process manager.
          </p>
          
          {#if loadingConfig}
            <p class="setting-description">Loading configuration status...</p>
          {:else if configStatus}
            <!-- GitHub Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('github')) {
                    expandedSections.delete('github');
                  } else {
                    expandedSections.add('github');
                  }
                  expandedSections = expandedSections; // Trigger reactivity
                }}
              >
                <span class="section-title">GitHub Integration</span>
                <span class="section-toggle">{expandedSections.has('github') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('github')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">GITHUB_TOKEN:</span>
                    <span class="config-value" class:configured={configStatus.github.tokenConfigured}>
                      {configStatus.github.tokenConfigured ? '✓ Configured' : '✗ Not configured'}
                    </span>
                  </div>
                  <div class="config-docs">
                    <p><strong>Purpose:</strong> GitHub Personal Access Token for API authentication</p>
                    <p><strong>Why needed:</strong> Without a token, you're limited to 60 requests/hour per IP. With a token, you get 5,000 requests/hour.</p>
                    <p><strong>How to set:</strong> <code>export GITHUB_TOKEN=your_token_here</code></p>
                    <p><strong>How to create:</strong> GitHub Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic) with <code>public_repo</code> scope</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Git Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('git')) {
                    expandedSections.delete('git');
                  } else {
                    expandedSections.add('git');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Git Configuration</span>
                <span class="section-toggle">{expandedSections.has('git') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('git')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">GIT_REPO_ROOT:</span>
                    <span class="config-value">{configStatus.git.repoRoot}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">GIT_DOMAIN:</span>
                    <span class="config-value">{configStatus.git.domain}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">DEFAULT_BRANCH:</span>
                    <span class="config-value">{configStatus.git.defaultBranch}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">GIT_OPERATION_TIMEOUT_MS:</span>
                    <span class="config-value">{configStatus.git.operationTimeoutMs}ms ({Math.round(configStatus.git.operationTimeoutMs / 1000 / 60)} min)</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">GIT_CLONE_TIMEOUT_MS:</span>
                    <span class="config-value">{configStatus.git.cloneTimeoutMs}ms ({Math.round(configStatus.git.cloneTimeoutMs / 1000 / 60)} min)</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">ALLOW_FORCE_PUSH:</span>
                    <span class="config-value">{configStatus.git.allowForcePush ? '✓ Enabled' : '✗ Disabled'}</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>GIT_REPO_ROOT:</strong> Directory where repositories are stored (default: <code>/repos</code>)</p>
                    <p><strong>GIT_DOMAIN:</strong> Domain for git clone URLs (default: <code>localhost:6543</code>)</p>
                    <p><strong>DEFAULT_BRANCH:</strong> Default branch name for new repositories (default: <code>master</code>)</p>
                    <p><strong>GIT_OPERATION_TIMEOUT_MS:</strong> Timeout for git operations in milliseconds (default: 300000 = 5 minutes)</p>
                    <p><strong>GIT_CLONE_TIMEOUT_MS:</strong> Timeout for git clone operations (default: 300000 = 5 minutes)</p>
                    <p><strong>ALLOW_FORCE_PUSH:</strong> Allow force push operations (default: <code>false</code>)</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Nostr Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('nostr')) {
                    expandedSections.delete('nostr');
                  } else {
                    expandedSections.add('nostr');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Nostr Configuration</span>
                <span class="section-toggle">{expandedSections.has('nostr') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('nostr')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">NOSTR_RELAYS:</span>
                    <span class="config-value">{configStatus.nostr.relays.length} relay(s) configured</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">NOSTR_SEARCH_RELAYS:</span>
                    <span class="config-value">{configStatus.nostr.searchRelays.length > 0 ? configStatus.nostr.searchRelays.length + ' relay(s)' : 'Using defaults'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">NIP98_AUTH_WINDOW_SECONDS:</span>
                    <span class="config-value">{configStatus.nostr.nip98AuthWindowSeconds}s</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>NOSTR_RELAYS:</strong> Comma-separated list of Nostr relays for publishing/fetching (default: <code>wss://theforest.nostr1.com,wss://nostr.land</code>)</p>
                    <p><strong>NOSTR_SEARCH_RELAYS:</strong> Comma-separated list of relays for searching (uses extended default list if not set)</p>
                    <p><strong>NIP98_AUTH_WINDOW_SECONDS:</strong> Authentication window for NIP-98 HTTP auth (default: 60 seconds)</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Tor Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('tor')) {
                    expandedSections.delete('tor');
                  } else {
                    expandedSections.add('tor');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Tor Support</span>
                <span class="section-toggle">{expandedSections.has('tor') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('tor')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">TOR_SOCKS_PROXY:</span>
                    <span class="config-value">{configStatus.tor.enabled ? configStatus.tor.socksProxy : 'Disabled'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">TOR_HOSTNAME_FILE:</span>
                    <span class="config-value">{configStatus.tor.hostnameFile || 'Not set'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">TOR_ONION_ADDRESS:</span>
                    <span class="config-value">{configStatus.tor.onionAddress || 'Not set'}</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>TOR_SOCKS_PROXY:</strong> Tor SOCKS proxy address (format: <code>host:port</code>, default: <code>127.0.0.1:9050</code>, set to empty to disable)</p>
                    <p><strong>TOR_HOSTNAME_FILE:</strong> Path to file containing Tor hidden service hostname</p>
                    <p><strong>TOR_ONION_ADDRESS:</strong> Tor .onion address for the service</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Security Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('security')) {
                    expandedSections.delete('security');
                  } else {
                    expandedSections.add('security');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Security Settings</span>
                <span class="section-toggle">{expandedSections.has('security') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('security')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">ADMIN_PUBKEYS:</span>
                    <span class="config-value" class:configured={configStatus.security.adminPubkeysConfigured}>
                      {configStatus.security.adminPubkeysConfigured ? '✓ Configured' : '✗ Not configured'}
                    </span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">AUDIT_LOGGING_ENABLED:</span>
                    <span class="config-value">{configStatus.security.auditLoggingEnabled ? '✓ Enabled' : '✗ Disabled'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">AUDIT_LOG_FILE:</span>
                    <span class="config-value">{configStatus.security.auditLogFile || 'Default location'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">AUDIT_LOG_RETENTION_DAYS:</span>
                    <span class="config-value">{configStatus.security.auditLogRetentionDays} days</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">RATE_LIMIT_ENABLED:</span>
                    <span class="config-value">{configStatus.security.rateLimitEnabled ? '✓ Enabled' : '✗ Disabled'}</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">RATE_LIMIT_WINDOW_MS:</span>
                    <span class="config-value">{configStatus.security.rateLimitWindowMs}ms ({Math.round(configStatus.security.rateLimitWindowMs / 1000)}s)</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>ADMIN_PUBKEYS:</strong> Comma-separated list of admin pubkeys (hex format) with elevated privileges</p>
                    <p><strong>AUDIT_LOGGING_ENABLED:</strong> Enable audit logging (default: <code>true</code>, set to <code>false</code> to disable)</p>
                    <p><strong>AUDIT_LOG_FILE:</strong> Path to audit log file (uses default if not set)</p>
                    <p><strong>AUDIT_LOG_RETENTION_DAYS:</strong> Number of days to retain audit logs (default: 90)</p>
                    <p><strong>RATE_LIMIT_ENABLED:</strong> Enable rate limiting (default: <code>true</code>, set to <code>false</code> to disable)</p>
                    <p><strong>RATE_LIMIT_WINDOW_MS:</strong> Rate limit window in milliseconds (default: 60000 = 1 minute)</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Resource Limits -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('resources')) {
                    expandedSections.delete('resources');
                  } else {
                    expandedSections.add('resources');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Resource Limits</span>
                <span class="section-toggle">{expandedSections.has('resources') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('resources')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">MAX_REPOS_PER_USER:</span>
                    <span class="config-value">{configStatus.resources.maxReposPerUser} repositories</span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">MAX_DISK_QUOTA_PER_USER:</span>
                    <span class="config-value">{Math.round(configStatus.resources.maxDiskQuotaPerUser / 1024 / 1024 / 1024)} GB ({configStatus.resources.maxDiskQuotaPerUser} bytes)</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>MAX_REPOS_PER_USER:</strong> Maximum number of repositories per user (default: 100)</p>
                    <p><strong>MAX_DISK_QUOTA_PER_USER:</strong> Maximum disk quota per user in bytes (default: 10737418240 = 10 GB)</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Messaging Configuration -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('messaging')) {
                    expandedSections.delete('messaging');
                  } else {
                    expandedSections.add('messaging');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Messaging Configuration</span>
                <span class="section-toggle">{expandedSections.has('messaging') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('messaging')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">MESSAGING_PREFS_ENCRYPTION_KEY:</span>
                    <span class="config-value" class:configured={configStatus.messaging.encryptionKeyConfigured}>
                      {configStatus.messaging.encryptionKeyConfigured ? '✓ Configured' : '✗ Not configured'}
                    </span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">MESSAGING_SALT_ENCRYPTION_KEY:</span>
                    <span class="config-value" class:configured={configStatus.messaging.saltEncryptionKeyConfigured}>
                      {configStatus.messaging.saltEncryptionKeyConfigured ? '✓ Configured' : '✗ Not configured'}
                    </span>
                  </div>
                  <div class="config-item">
                    <span class="config-label">MESSAGING_LOOKUP_SECRET:</span>
                    <span class="config-value" class:configured={configStatus.messaging.lookupSecretConfigured}>
                      {configStatus.messaging.lookupSecretConfigured ? '✓ Configured' : '✗ Not configured'}
                    </span>
                  </div>
                  <div class="config-docs">
                    <p><strong>MESSAGING_PREFS_ENCRYPTION_KEY:</strong> Encryption key for messaging preferences</p>
                    <p><strong>MESSAGING_SALT_ENCRYPTION_KEY:</strong> Encryption key for salt values</p>
                    <p><strong>MESSAGING_LOOKUP_SECRET:</strong> Secret for message lookup operations</p>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Enterprise Mode -->
            <div class="config-section">
              <button 
                class="config-section-header"
                onclick={() => {
                  if (expandedSections.has('enterprise')) {
                    expandedSections.delete('enterprise');
                  } else {
                    expandedSections.add('enterprise');
                  }
                  expandedSections = expandedSections;
                }}
              >
                <span class="section-title">Enterprise Mode</span>
                <span class="section-toggle">{expandedSections.has('enterprise') ? '▼' : '▶'}</span>
              </button>
              {#if expandedSections.has('enterprise')}
                <div class="config-status">
                  <div class="config-item">
                    <span class="config-label">ENTERPRISE_MODE:</span>
                    <span class="config-value">{configStatus.enterprise.enabled ? '✓ Enabled' : '✗ Disabled (Lightweight mode)'}</span>
                  </div>
                  <div class="config-docs">
                    <p><strong>ENTERPRISE_MODE:</strong> Enable enterprise mode for Kubernetes container-per-tenant architecture (default: <code>false</code>, set to <code>true</code> to enable)</p>
                  </div>
                </div>
              {/if}
            </div>
          {:else}
            <p class="setting-description">Failed to load configuration status.</p>
          {/if}
        </div>

        <div class="setting-group">
          <ForwardingConfig 
            userPubkeyHex={$userStore.userPubkeyHex} 
            showTitle={true}
            compact={false}
          />
        </div>
      {/if}
    </div>

    <div class="settings-actions">
      <button onclick={saveSettings} class="save-button" disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  {/if}
</div>

<style>
  .settings-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    min-height: calc(100vh - 4rem);
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }

  .settings-header h1 {
    margin: 0;
    font-size: 2rem;
    color: var(--text-primary);
  }

  .back-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s ease;
  }

  .back-button:hover {
    background: var(--bg-tertiary);
    border-color: var(--accent);
  }


  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 2rem;
  }

  .tab-button {
    padding: 0.75rem 1.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .tab-button:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab-button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 500;
  }

  .settings-content {
    padding: 1.5rem 0;
  }

  .setting-group {
    margin-bottom: 2rem;
  }

  .setting-group:last-child {
    margin-bottom: 0;
  }

  .setting-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .label-text {
    flex: 1;
  }

  .toggle-container {
    display: flex;
    align-items: center;
  }

  .toggle-input {
    display: none;
  }

  .toggle-label {
    position: relative;
    width: 44px;
    height: 24px;
    background: var(--bg-tertiary);
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .toggle-input:checked + .toggle-label {
    background: var(--accent);
  }

  .toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    background: white;
    border-radius: 50%;
    transition: transform 0.2s ease;
  }

  .toggle-input:checked + .toggle-label .toggle-slider {
    transform: translateX(20px);
  }

  .setting-input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 0.5rem;
    box-sizing: border-box;
  }

  .setting-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .setting-hint {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: -0.25rem 0 0.5rem 0;
  }

  .setting-description {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: 0.5rem 0 0 0;
  }

  .theme-options {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  @media (max-width: 768px) {
    .theme-options {
      flex-direction: column;
    }

    .theme-option {
      width: 100%;
      min-width: auto;
    }
  }

  .theme-option {
    flex: 1;
    min-width: 120px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    border: 2px solid var(--border-color);
    border-radius: 0.375rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 0.875rem;
  }

  .theme-option:hover {
    border-color: var(--accent);
    background: var(--bg-secondary);
  }

  .theme-option.active {
    border-color: var(--accent);
    background: var(--bg-tertiary);
    font-weight: 600;
  }

  .theme-icon {
    width: 24px;
    height: 24px;
    filter: brightness(0) saturate(100%) invert(1);
  }

  :global([data-theme="light"]) .theme-icon {
    filter: brightness(0) saturate(100%);
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }

  .settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 2rem 0;
    border-top: 1px solid var(--border-color);
    margin-top: 2rem;
  }

  .save-button {
    padding: 0.75rem 1.5rem;
    border: 1px solid var(--accent);
    border-radius: 0.375rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s ease;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .save-button:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .setting-section-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color);
  }

  .config-status {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    padding: 1rem;
  }

  .config-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-color);
  }

  .config-item:last-child {
    border-bottom: none;
  }

  .config-label {
    font-weight: 500;
    color: var(--text-primary);
  }

  .config-value {
    color: var(--text-secondary);
    font-family: monospace;
    font-size: 0.875rem;
  }

  .config-value.configured {
    color: var(--success-color, #10b981);
    font-weight: 600;
  }

  .config-section {
    margin-bottom: 1rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .config-section-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--bg-secondary);
    border: none;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    transition: background 0.2s ease;
  }

  .config-section-header:hover {
    background: var(--bg-tertiary);
  }

  .section-title {
    flex: 1;
    text-align: left;
  }

  .section-toggle {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-left: 1rem;
  }

  .config-docs {
    margin-top: 0.75rem;
    padding: 0.75rem;
    background: var(--bg-tertiary);
    border-radius: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .config-docs p {
    margin: 0.5rem 0;
  }

  .config-docs p:first-child {
    margin-top: 0;
  }

  .config-docs p:last-child {
    margin-bottom: 0;
  }

  .config-docs code {
    background: var(--bg-primary);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--text-primary);
  }

  .config-docs strong {
    color: var(--text-primary);
    font-weight: 600;
  }
</style>
