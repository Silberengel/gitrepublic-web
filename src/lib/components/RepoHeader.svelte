<script lang="ts">
  import UserBadge from './UserBadge.svelte';
  import { nip19 } from 'nostr-tools';

  interface Props {
    repoName: string;
    repoDescription?: string;
    ownerNpub: string;
    ownerPubkey: string;
    isMaintainer: boolean;
    isPrivate?: boolean;
    cloneUrls?: string[];
    onMenuToggle?: () => void;
    showMenu?: boolean;
  }

  let { 
    repoName, 
    repoDescription, 
    ownerNpub, 
    ownerPubkey,
    isMaintainer,
    isPrivate = false,
    cloneUrls = [],
    onMenuToggle,
    showMenu = false
  }: Props = $props();

  let showCloneMenu = $state(false);
  let showMoreMenu = $state(false);
</script>

<header class="repo-header">
  <div class="repo-header-top">
    <div class="repo-title-section">
      <h1 class="repo-name">{repoName}</h1>
      {#if isPrivate}
        <span class="repo-badge private">Private</span>
      {/if}
    </div>
    <div class="repo-header-actions">
      <button 
        class="menu-button" 
        onclick={() => onMenuToggle?.()}
        aria-label="Menu"
      >
        <img src="/icons/menu.svg" alt="" class="icon" />
      </button>
    </div>
  </div>
  
  {#if repoDescription}
    <p class="repo-description">{repoDescription}</p>
  {/if}

  <div class="repo-meta">
    <div class="repo-owner">
      <span class="meta-label">Owner:</span>
      <UserBadge pubkey={ownerPubkey} />
    </div>
    
    {#if cloneUrls.length > 0}
      <div class="repo-clone">
        <button 
          class="clone-button"
          onclick={() => showCloneMenu = !showCloneMenu}
          aria-expanded={showCloneMenu}
        >
          <img src="/icons/git-branch.svg" alt="" class="icon" />
          Clone
        </button>
        {#if showCloneMenu}
          <div class="clone-menu">
            {#each cloneUrls as url}
              <button 
                class="clone-url-item"
                onclick={() => {
                  navigator.clipboard.writeText(url);
                  showCloneMenu = false;
                }}
              >
                {url}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if showMenu}
      <div class="repo-menu">
        <button 
          class="more-button"
          onclick={() => showMoreMenu = !showMoreMenu}
          aria-expanded={showMoreMenu}
        >
          <img src="/icons/more-vertical.svg" alt="" class="icon" />
        </button>
        {#if showMoreMenu}
          <div class="more-menu">
            {#if isMaintainer}
              <button class="menu-item">Settings</button>
              <button class="menu-item">Transfer</button>
            {/if}
            <button class="menu-item">Bookmark</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .repo-header {
    padding: 0.75rem 1rem;
    background: var(--card-bg, #ffffff);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .repo-header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .repo-title-section {
    flex: 1;
    min-width: 0;
  }

  .repo-name {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary, #1a1a1a);
    word-break: break-word;
  }

  .repo-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    margin-left: 0.5rem;
    font-size: 0.75rem;
    border-radius: 0.25rem;
    font-weight: 500;
  }

  .repo-badge.private {
    background: var(--error-bg, #fee);
    color: var(--error-text, #c00);
  }

  .repo-header-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .menu-button,
  .clone-button,
  .more-button {
    padding: 0.5rem;
    background: transparent;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.375rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-primary, #1a1a1a);
    transition: all 0.2s ease;
  }

  .menu-button:hover,
  .clone-button:hover,
  .more-button:hover {
    background: var(--bg-secondary, #f5f5f5);
    border-color: var(--accent, #007bff);
  }

  .icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  .repo-description {
    margin: 0.5rem 0;
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
    line-height: 1.5;
  }

  .repo-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    margin-top: 0.75rem;
    font-size: 0.875rem;
  }

  .repo-owner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .meta-label {
    color: var(--text-secondary, #666);
  }

  .repo-clone {
    position: relative;
  }

  .clone-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    background: var(--card-bg, #ffffff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.375rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    z-index: 10;
    min-width: 200px;
    max-width: 90vw;
  }

  .clone-url-item {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
    text-align: left;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    cursor: pointer;
    font-size: 0.75rem;
    font-family: 'IBM Plex Mono', monospace;
    color: var(--text-primary, #1a1a1a);
    word-break: break-all;
  }

  .clone-url-item:last-child {
    border-bottom: none;
  }

  .clone-url-item:hover {
    background: var(--bg-secondary, #f5f5f5);
  }

  .repo-menu {
    position: relative;
    margin-left: auto;
  }

  .more-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.25rem;
    background: var(--card-bg, #ffffff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.375rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    z-index: 10;
    min-width: 150px;
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
    text-align: left;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-primary, #1a1a1a);
  }

  .menu-item:last-child {
    border-bottom: none;
  }

  .menu-item:hover {
    background: var(--bg-secondary, #f5f5f5);
  }

  @media (min-width: 768px) {
    .repo-header {
      padding: 1rem 1.5rem;
    }

    .repo-name {
      font-size: 1.5rem;
    }

    .repo-description {
      font-size: 1rem;
    }
  }
</style>
