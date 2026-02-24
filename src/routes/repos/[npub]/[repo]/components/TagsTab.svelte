<script lang="ts">
  import { downloadRepository } from '../utils/download.js';
  import { buildApiHeaders } from '../utils/api-client.js';
  import logger from '$lib/services/logger.js';
  import TabsMenu from '$lib/components/TabsMenu.svelte';

  interface Props {
    npub: string;
    repo: string;
    tags: Array<{ name: string; hash: string; message?: string; date?: number }>;
    releases: Array<{
      id: string;
      tagName: string;
      tagHash?: string;
      releaseNotes?: string;
      isDraft?: boolean;
      isPrerelease?: boolean;
      created_at: number;
      pubkey: string;
    }>;
    selectedTag: string | null;
    isMaintainer: boolean;
    userPubkeyHex: string | null;
    repoOwnerPubkeyDerived: string;
    isRepoCloned: boolean | null;
    canViewRepo: boolean;
    canUseApiFallback: boolean;
    needsClone: boolean;
    cloneTooltip: string;
    activeTab: string;
    tabs: Array<{ id: string; label: string; icon?: string }>;
    showLeftPanelOnMobile: boolean;
    onTagSelect: (tagName: string) => void;
    onTabChange: (tab: string) => void;
    onToggleMobilePanel: () => void;
    onCreateTag: () => void;
    onCreateRelease: (tagName: string, tagHash: string) => void;
    onLoadTags: () => Promise<void>;
  }

  let {
    npub,
    repo,
    tags,
    releases,
    selectedTag,
    isMaintainer,
    userPubkeyHex,
    repoOwnerPubkeyDerived,
    isRepoCloned,
    canViewRepo,
    canUseApiFallback,
    needsClone,
    cloneTooltip,
    activeTab,
    tabs,
    showLeftPanelOnMobile,
    onTagSelect,
    onTabChange,
    onToggleMobilePanel,
    onCreateTag,
    onCreateRelease,
    onLoadTags
  }: Props = $props();

  let loadingTags = $state(false);
  let downloadError = $state<string | null>(null);

  async function handleDownloadTag(tagName: string) {
    downloadError = null;
    try {
      logger.info({ npub, repo, tag: tagName }, '[TagsTab] Starting tag download');
      await downloadRepository({
        npub,
        repo,
        ref: tagName,
        filename: `${repo}-${tagName}.zip`
      });
      logger.info({ npub, repo, tag: tagName }, '[TagsTab] Tag download completed');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to download tag';
      logger.error({ error: err, npub, repo, tag: tagName }, '[TagsTab] Tag download failed');
      downloadError = errorMessage;
      // Show error to user
      alert(`Download failed: ${errorMessage}`);
    }
  }

  async function handleCreateTag() {
    if (!userPubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }
    onCreateTag();
  }

  function handleCreateRelease(tagName: string, tagHash: string) {
    onCreateRelease(tagName, tagHash);
  }
</script>

{#if activeTab === 'tags' && canViewRepo}
  <aside class="tags-sidebar" class:hide-on-mobile={!showLeftPanelOnMobile && activeTab === 'tags'}>
    <div class="tags-header">
      <TabsMenu 
        {activeTab} 
        {tabs} 
        onTabChange={(tab) => onTabChange(tab as string)}
      />
      <h2>Tags {#if isRepoCloned === false && canUseApiFallback}<span class="read-only-badge">Read-Only</span>{/if}</h2>
      {#if userPubkeyHex && isMaintainer}
        <button 
          onclick={handleCreateTag}
          class="create-tag-button"
          disabled={needsClone}
          title={needsClone ? cloneTooltip : 'Create a new tag'}
        >
          <img src="/icons/plus.svg" alt="New Tag" class="icon" />
        </button>
      {/if}
      <button 
        onclick={onToggleMobilePanel} 
        class="mobile-toggle-button"
        title="Show content"
      >
        <img src="/icons/arrow-right.svg" alt="Show content" class="icon-inline" />
      </button>
    </div>
    {#if loadingTags}
      <div class="loading">Loading tags...</div>
    {:else if tags.length > 0}
      <ul class="tag-list">
        {#each tags as tag}
          {@const tagHash = tag.hash || ''}
          {#if tagHash}
            <li class="tag-item" class:selected={selectedTag === tag.name}>
              <button 
                onclick={() => onTagSelect(tag.name)}
                class="tag-item-button"
              >
                <div class="tag-name">{tag.name}</div>
                <div class="tag-hash">{tagHash.slice(0, 7)}</div>
                {#if tag.date}
                  <div class="tag-date">{new Date(tag.date * 1000).toLocaleDateString()}</div>
                {/if}
                {#if releases.find(r => r.tagName === tag.name)}
                  <img src="/icons/package.svg" alt="Has release" class="tag-has-release-icon" title="This tag has a release" />
                {/if}
              </button>
            </li>
          {/if}
        {/each}
      </ul>
    {:else}
      <div class="empty-state">
        <p>No tags found</p>
      </div>
    {/if}
  </aside>
{/if}

{#if activeTab === 'tags'}
  <div class="tags-content" class:hide-on-mobile={showLeftPanelOnMobile && activeTab === 'tags'}>
    <div class="content-header-mobile">
      <button 
        onclick={onToggleMobilePanel} 
        class="mobile-toggle-button"
        title="Show list"
      >
        <img src="/icons/arrow-right.svg" alt="Show list" class="icon-inline mobile-toggle-left" />
      </button>
    </div>
    {#if selectedTag}
      {@const tag = tags.find(t => t.name === selectedTag)}
      {@const release = releases.find(r => r.tagName === selectedTag)}
      {#if tag}
        <div class="tag-detail">
          <div class="tag-detail-header">
            <h3>{tag.name}</h3>
            <div class="tag-detail-meta">
              <span>Tag: {tag.hash?.slice(0, 7) || 'N/A'}</span>
              {#if tag.date}
                <span class="tag-date">Created {new Date(tag.date * 1000).toLocaleString()}</span>
              {/if}
              <button 
                type="button"
                class="download-tag-button"
                title="Download source code as ZIP"
                onclick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.stopImmediatePropagation();
                  await handleDownloadTag(tag.name);
                }}
              >
                <img src="/icons/download.svg" alt="Download" class="icon-inline" />
                Download ZIP
              </button>
              {#if downloadError}
                <div class="error-message" style="color: red; margin-top: 0.5rem;">
                  {downloadError}
                </div>
              {/if}
              {#if (isMaintainer || userPubkeyHex === repoOwnerPubkeyDerived) && isRepoCloned && !release}
                <button 
                  onclick={() => handleCreateRelease(tag.name, tag.hash || '')}
                  class="release-tag-button"
                  title="Create a release for this tag"
                >
                  Release this tag
                </button>
              {/if}
            </div>
          </div>
          {#if tag.message}
            <div class="tag-message">
              <p>{tag.message}</p>
            </div>
          {/if}
          {#if release}
            <div class="tag-release-section">
              <h4>Release</h4>
              <div class="release-info">
                {#if release.isDraft}
                  <span class="release-badge draft">Draft</span>
                {/if}
                {#if release.isPrerelease}
                  <span class="release-badge prerelease">Pre-release</span>
                {/if}
                <div class="release-meta">
                  <span>Released {new Date(release.created_at * 1000).toLocaleDateString()}</span>
                </div>
                {#if release.releaseNotes}
                  <div class="release-notes">
                    {@html release.releaseNotes.replace(/\n/g, '<br>')}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="empty-state">
        <p>Select a tag from the sidebar to view details</p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .tags-sidebar {
    width: 300px;
    border-right: 1px solid var(--border-color);
    overflow-y: auto;
    background: var(--bg-primary);
  }

  .tags-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tags-header h2 {
    flex: 1;
    margin: 0;
    font-size: 1.2rem;
    color: var(--text-primary); /* Ensure proper contrast in dark themes */
  }

  .create-tag-button {
    padding: 0.5rem;
    background: var(--button-primary);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .tag-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .tag-item {
    border-bottom: 1px solid var(--border-color);
  }

  .tag-item-button {
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    color: var(--text-primary); /* Ensure proper contrast in dark themes */
  }

  .tag-item-button:hover {
    background: var(--bg-secondary);
  }

  .tag-item.selected .tag-item-button {
    background: var(--bg-secondary);
    font-weight: bold;
  }

  .tag-name {
    font-weight: 500;
    color: var(--text-primary); /* Ensure proper contrast in dark themes */
  }

  .tag-hash {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  .tag-date {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .tags-content {
    flex: 1;
    padding: 1rem;
    overflow-y: auto;
  }

  .tag-detail {
    max-width: 800px;
  }

  .tag-detail-header h3 {
    margin: 0 0 0.5rem 0;
    color: var(--text-primary); /* Ensure proper contrast in dark themes */
  }

  .tag-detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    margin-top: 0.5rem;
    color: var(--text-primary); /* Ensure proper contrast in dark themes */
  }
  
  .tag-detail-meta span {
    color: var(--text-secondary); /* Secondary text for meta info */
  }

  .tag-message {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
  }

  .tag-release-section {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
  }

  .release-badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.85rem;
    margin-right: 0.5rem;
  }

  .release-badge.draft {
    background: var(--warning-bg);
    color: var(--warning-text);
  }

  .release-badge.prerelease {
    background: var(--info-bg);
    color: var(--info-text);
  }

  .download-tag-button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 4px;
    text-decoration: none;
    font-size: 0.9rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
    cursor: pointer;
  }

  .download-tag-button:hover {
    background: var(--button-primary-hover);
  }

  .download-tag-button .icon-inline {
    width: 16px;
    height: 16px;
  }

  .tag-has-release-icon {
    width: 16px;
    height: 16px;
    vertical-align: middle;
    opacity: 0.8;
    /* White icon for both dark themes */
    filter: brightness(0) saturate(100%) invert(1);
  }

  .error-message {
    color: var(--error-color, red);
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }
</style>
