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
    branches?: Array<string | { name: string }>;
    currentBranch?: string | null;
    defaultBranch?: string | null;
    isRepoCloned?: boolean | null;
    copyingCloneUrl?: boolean;
    onBranchChange?: (branch: string) => void;
    onCopyCloneUrl?: () => void;
    onDeleteBranch?: (branch: string) => void;
    onMenuToggle?: () => void;
    showMenu?: boolean;
    userPubkey?: string | null;
    isBookmarked?: boolean;
    loadingBookmark?: boolean;
    onToggleBookmark?: () => void;
    onFork?: () => void;
    forking?: boolean;
    onCloneToServer?: () => void;
    cloning?: boolean;
    checkingCloneStatus?: boolean;
    onCreateIssue?: () => void;
    onCreatePR?: () => void;
    onCreatePatch?: () => void;
    onCreateBranch?: () => void;
    onSettings?: () => void;
    onGenerateVerification?: () => void;
    onDeleteAnnouncement?: () => void;
    deletingAnnouncement?: boolean;
    hasUnlimitedAccess?: boolean;
    needsClone?: boolean;
  }

  let { 
    repoName, 
    repoDescription, 
    ownerNpub, 
    ownerPubkey,
    isMaintainer,
    isPrivate = false,
    cloneUrls = [],
    branches = [],
    currentBranch = null,
    defaultBranch = null,
    isRepoCloned = null,
    copyingCloneUrl = false,
    onBranchChange,
    onCopyCloneUrl,
    onDeleteBranch,
    onMenuToggle,
    showMenu = false,
    userPubkey = null,
    isBookmarked = false,
    loadingBookmark = false,
    onToggleBookmark,
    onFork,
    forking = false,
    onCloneToServer,
    cloning = false,
    checkingCloneStatus = false,
    onCreateIssue,
    onCreatePR,
    onCreatePatch,
    onCreateBranch,
    onSettings,
    onGenerateVerification,
    onDeleteAnnouncement,
    deletingAnnouncement = false,
    hasUnlimitedAccess = false,
    needsClone = false
  }: Props = $props();

  let showCloneMenu = $state(false);
  let showMoreMenu = $state(false);
  let showBranchMenu = $state(false);
</script>

<header class="repo-header">
  <div class="repo-header-top">
    <div class="repo-title-section">
      <h1 class="repo-name">{repoName}</h1>
      {#if isPrivate}
        <span class="repo-badge private">Private</span>
      {/if}
      {#if userPubkey && onToggleBookmark}
        <button
          class="bookmark-button"
          class:bookmarked={isBookmarked}
          onclick={() => onToggleBookmark?.()}
          disabled={loadingBookmark}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
        >
          <img src="/icons/star.svg" alt="" class="icon" />
        </button>
      {/if}
    </div>
    <div class="repo-header-actions">
      {#if userPubkey}
        <button 
          class="menu-button" 
          onclick={() => {
            onMenuToggle?.();
            showMoreMenu = !showMoreMenu;
          }}
          aria-label="Menu"
        >
          <img src="/icons/more-vertical.svg" alt="" class="icon" />
        </button>
      {/if}
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

    {#if branches.length > 0 && currentBranch}
      <div class="repo-branch">
        <button 
          class="branch-button"
          onclick={() => showBranchMenu = !showBranchMenu}
          aria-expanded={showBranchMenu}
        >
          <img src="/icons/git-branch.svg" alt="" class="icon" />
          {currentBranch}
        </button>
        {#if showBranchMenu}
          <div class="branch-menu">
            {#each branches as branch}
              {@const branchName = typeof branch === 'string' ? branch : branch.name}
              <button 
                class="branch-item"
                class:active={branchName === currentBranch}
                onclick={() => {
                  onBranchChange?.(branchName);
                  showBranchMenu = false;
                }}
              >
                {branchName}
                {#if branchName === defaultBranch}
                  <span class="branch-badge">default</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        {#if isMaintainer && currentBranch && currentBranch !== defaultBranch && onDeleteBranch}
          <button 
            class="delete-branch-button"
            onclick={() => currentBranch && onDeleteBranch(currentBranch)}
            title="Delete branch"
          >
            ×
          </button>
        {/if}
      </div>
    {/if}

    {#if isRepoCloned === true && onCopyCloneUrl}
      <button 
        class="copy-clone-button"
        onclick={() => onCopyCloneUrl()}
        disabled={copyingCloneUrl}
        title="Copy clone URL"
      >
        <img src="/icons/copy.svg" alt="" class="icon" />
        {copyingCloneUrl ? 'Copying...' : 'Copy Clone URL'}
      </button>
    {/if}
  </div>

  {#if showMoreMenu && userPubkey}
    <div 
      class="more-menu-overlay" 
      onclick={() => showMoreMenu = false}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          showMoreMenu = false;
        }
      }}
      role="button"
      tabindex="0"
      aria-label="Close menu"
    ></div>
    <div class="more-menu">
      {#if onFork}
        <button class="menu-item" onclick={() => { onFork(); showMoreMenu = false; }} disabled={forking}>
          {forking ? 'Forking...' : 'Fork'}
        </button>
      {/if}
      {#if onCreateIssue}
        <button class="menu-item" onclick={() => { onCreateIssue(); showMoreMenu = false; }}>
          Create Issue
        </button>
      {/if}
      {#if onCreatePR}
        <button class="menu-item" onclick={() => { onCreatePR(); showMoreMenu = false; }}>
          Create Pull Request
        </button>
      {/if}
      {#if onCreatePatch}
        <button class="menu-item" onclick={() => { onCreatePatch(); showMoreMenu = false; }}>
          Create Patch
        </button>
      {/if}
      {#if hasUnlimitedAccess && (isRepoCloned === false || isRepoCloned === null) && onCloneToServer}
        <button 
          class="menu-item" 
          onclick={() => { onCloneToServer(); showMoreMenu = false; }} 
          disabled={cloning || checkingCloneStatus}
        >
          {cloning ? 'Cloning...' : (checkingCloneStatus ? 'Checking...' : 'Clone to Server')}
        </button>
      {/if}
      {#if isMaintainer && onSettings}
        <button class="menu-item" onclick={() => { onSettings(); showMoreMenu = false; }}>
          Settings
        </button>
      {/if}
      {#if onGenerateVerification}
        <button class="menu-item" onclick={() => { onGenerateVerification(); showMoreMenu = false; }}>
          Generate Verification File
        </button>
      {/if}
      {#if onDeleteAnnouncement}
        <button 
          class="menu-item menu-item-danger" 
          onclick={() => { onDeleteAnnouncement(); showMoreMenu = false; }} 
          disabled={deletingAnnouncement}
        >
          {deletingAnnouncement ? 'Deleting...' : 'Delete Announcement'}
        </button>
      {/if}
      {#if isMaintainer && onCreateBranch}
        <button 
          class="menu-item" 
          onclick={() => { onCreateBranch(); showMoreMenu = false; }} 
          disabled={needsClone}
        >
          Create New Branch
        </button>
      {/if}
    </div>
  {/if}
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
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
    font-size: 0.75rem;
    border-radius: 0.25rem;
    font-weight: 500;
  }

  .repo-badge.private {
    background: var(--error-bg, #fee);
    color: var(--error-text, #c00);
  }

  .bookmark-button {
    padding: 0.25rem;
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .bookmark-button.bookmarked img {
    filter: brightness(0) saturate(100%) invert(67%) sepia(93%) saturate(1352%) hue-rotate(358deg) brightness(102%) contrast(106%);
  }

  .repo-header-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .menu-button,
  .clone-button,
  .branch-button,
  .copy-clone-button {
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
  .branch-button:hover,
  .copy-clone-button:hover {
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

  .repo-clone,
  .repo-branch {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .clone-menu,
  .branch-menu {
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
    max-height: 300px;
    overflow-y: auto;
  }

  .clone-url-item,
  .branch-item {
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
    word-break: break-all;
  }

  .branch-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    word-break: normal;
  }

  .branch-item.active {
    background: var(--bg-secondary, #f5f5f5);
    font-weight: 600;
  }

  .branch-badge {
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary, #f5f5f5);
    border-radius: 0.25rem;
    color: var(--text-secondary, #666);
  }

  .clone-url-item:last-child,
  .branch-item:last-child {
    border-bottom: none;
  }

  .clone-url-item:hover,
  .branch-item:hover {
    background: var(--bg-secondary, #f5f5f5);
  }

  .delete-branch-button {
    padding: 0.25rem 0.5rem;
    background: var(--error-text, #dc2626);
    color: #ffffff;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .delete-branch-button:hover {
    background: var(--error-hover, #c82333);
  }

  .more-menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 99;
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
    z-index: 100;
    min-width: 200px;
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

  .menu-item:hover:not(:disabled) {
    background: var(--bg-secondary, #f5f5f5);
  }

  .menu-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .menu-item-danger {
    color: var(--error-text, #dc2626);
  }

  .menu-item-danger:hover:not(:disabled) {
    background: var(--error-bg, #fee);
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
