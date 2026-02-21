<script lang="ts">
  import { onMount } from 'svelte';
  import { settingsStore } from '../services/settings-store.js';
  import { userStore } from '../stores/user-store.js';
  import { fetchUserEmail, fetchUserName, fetchUserProfile, extractProfileData, getUserName, getUserEmail } from '../utils/user-profile.js';
  import { DEFAULT_NOSTR_RELAYS } from '../config.js';
  import ForwardingConfig from './ForwardingConfig.svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: 'general' | 'git-setup' | 'connections';
  }

  let { isOpen, onClose, initialTab = 'general' }: Props = $props();

  let activeTab = $state<'general' | 'git-setup' | 'connections'>('general');
  let autoSave = $state(false);
  let userName = $state('');
  let userEmail = $state('');
  let theme = $state<'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black'>('gitrepublic-dark');
  let defaultBranch = $state('master');
  let loading = $state(false);
  let saving = $state(false);
  let loadingPresets = $state(false);
  let settingsLoaded = $state(false);

  // Preset values that will be used if user doesn't override
  let presetUserName = $state('');
  let presetUserEmail = $state('');

  async function loadSettings() {
    if (settingsLoaded) return; // Don't reload if already loaded
    loading = true;
    try {
      console.log('[SettingsModal] Loading settings from store...');
      const settings = await settingsStore.getSettings();
      console.log('[SettingsModal] Settings loaded:', settings);
      autoSave = settings.autoSave;
      userName = settings.userName;
      userEmail = settings.userEmail;
      theme = settings.theme;
      defaultBranch = settings.defaultBranch;
      settingsLoaded = true;
    } catch (err) {
      console.error('[SettingsModal] Failed to load settings:', err);
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

      onClose();
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

  // Watch for modal open/close and initialTab changes
  $effect(() => {
    console.log('[SettingsModal] $effect triggered, isOpen:', isOpen);
    if (isOpen) {
      console.log('[SettingsModal] Modal is open, loading settings and presets');
      // Set active tab when modal opens (use initialTab prop if provided)
      if (initialTab) {
        activeTab = initialTab;
      }
      // Load settings and presets when modal opens
      loadSettings().catch(err => console.error('[SettingsModal] Error loading settings:', err));
      loadPresets().catch(err => console.error('[SettingsModal] Error loading presets:', err));
    } else {
      console.log('[SettingsModal] Modal is closed');
      // Reset settings loaded flag when modal closes so it reloads next time
      settingsLoaded = false;
    }
  });
  
  // Also watch for initialTab prop changes when modal is open
  $effect(() => {
    if (isOpen && initialTab) {
      activeTab = initialTab;
    }
  });
</script>

{#if isOpen}
<!-- Settings Modal: isOpen={isOpen} -->
<div 
  class="modal-overlay" 
  role="button"
  tabindex="0"
  onclick={(e) => {
    console.log('[SettingsModal] Overlay clicked, target:', e.target, 'currentTarget:', e.currentTarget, 'isOpen:', isOpen);
    if (e.target === e.currentTarget) {
      onClose();
    }
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }}
>
    <div class="modal-content">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="close-button" onclick={onClose} aria-label="Close">
          <img src="/icons/x.svg" alt="Close" class="close-icon" />
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
            onclick={() => activeTab = 'general'}
          >
            General
          </button>
          <button 
            class="tab-button" 
            class:active={activeTab === 'git-setup'}
            onclick={() => activeTab = 'git-setup'}
          >
            Git Setup
          </button>
          <button 
            class="tab-button" 
            class:active={activeTab === 'connections'}
            onclick={() => activeTab = 'connections'}
          >
            Connections
          </button>
        </div>

        <div class="modal-body">
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
            <div class="setting-group">
              <ForwardingConfig 
                userPubkeyHex={$userStore.userPubkeyHex} 
                showTitle={true}
                compact={false}
              />
            </div>
          {/if}
        </div>

        <div class="modal-actions">
          <button onclick={onClose} class="cancel-button">Cancel</button>
          <button onclick={saveSettings} class="save-button" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 1rem;
  }

  .modal-content {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    max-width: 600px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem;
    border-bottom: 1px solid var(--border-color);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .close-button {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    transition: background 0.2s ease;
  }

  .close-button:hover {
    background: var(--bg-secondary);
  }

  .close-icon {
    width: 20px;
    height: 20px;
    filter: brightness(0) saturate(100%) invert(1);
  }

  :global([data-theme="light"]) .close-icon {
    filter: brightness(0) saturate(100%);
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-color);
    padding: 0 1.5rem;
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

  .modal-body {
    padding: 1.5rem;
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

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1.5rem;
    border-top: 1px solid var(--border-color);
  }

  .cancel-button,
  .save-button {
    padding: 0.75rem 1.5rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .cancel-button {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .cancel-button:hover {
    background: var(--bg-tertiary);
  }

  .save-button {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border-color: var(--accent);
  }

  .save-button:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
