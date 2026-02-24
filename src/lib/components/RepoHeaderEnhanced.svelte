<script lang="ts">
  import UserBadge from './UserBadge.svelte';
  import { nip19 } from 'nostr-tools';
  import '$lib/styles/components.css';

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
    allMaintainers?: Array<{ pubkey: string; isOwner: boolean }>;
    onCopyEventId?: () => void;
    topics?: string[];
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
    needsClone = false,
    allMaintainers = [],
    onCopyEventId,
    topics = []
  }: Props = $props();

  let showMoreMenu = $state(false);
  let showBranchMenu = $state(false);
  let showOwnerMenu = $state(false);
  let moreMenuElement = $state<HTMLDivElement | null>(null);
  let menuButtonElement = $state<HTMLButtonElement | null>(null);
  
  // Adjust menu position to prevent overflow on the left side (menu opens to the left)
  $effect(() => {
    if (showMoreMenu && moreMenuElement && menuButtonElement) {
      // Use double requestAnimationFrame to ensure DOM is fully rendered
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!moreMenuElement || !menuButtonElement) return;
          
          const menuRect = moreMenuElement.getBoundingClientRect();
          const buttonRect = menuButtonElement.getBoundingClientRect();
          const viewportWidth = window.innerWidth;
          const padding = 16; // Padding from viewport edges
          
          // Menu is positioned with right: 0, so its right edge aligns with button's right edge
          // Calculate where the menu's left edge currently is
          const menuWidth = menuRect.width || 280; // Fallback to min-width
          const currentRight = buttonRect.right;
          const currentLeft = currentRight - menuWidth;
          
          let transformX = 0;
          
          // Check if menu overflows on the left
          if (currentLeft < padding) {
            // Menu would overflow on the left, shift it right
            const leftOverflow = padding - currentLeft;
            transformX = leftOverflow;
            
            // Re-check right after adjustment - ensure we don't go off right
            const finalRight = currentRight + transformX;
            if (finalRight > viewportWidth - padding) {
              // If we'd go off right, position it at the right edge with padding
              transformX = (viewportWidth - padding) - currentRight;
            }
          }
          
          moreMenuElement.style.transform = `translateX(${transformX}px)`;
        });
      });
    } else if (moreMenuElement) {
      // Reset transform when menu closes
      moreMenuElement.style.transform = '';
    }
  });
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
        <div class="menu-button-wrapper">
          <button 
            class="menu-button" 
            bind:this={menuButtonElement}
            onclick={() => {
              onMenuToggle?.();
              showMoreMenu = !showMoreMenu;
            }}
            aria-label="Menu"
          >
            <img src="/icons/more-vertical.svg" alt="" class="icon" />
          </button>
          {#if showMoreMenu}
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
            <div class="more-menu" bind:this={moreMenuElement}>
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
              {#if (isRepoCloned === false || isRepoCloned === null) && onCloneToServer}
                <button 
                  class="menu-item" 
                  onclick={() => { 
                    if (hasUnlimitedAccess) {
                      onCloneToServer(); 
                    }
                    showMoreMenu = false; 
                  }} 
                  disabled={cloning || checkingCloneStatus || !hasUnlimitedAccess}
                  title={!hasUnlimitedAccess ? 'Unlimited access required to clone repositories' : undefined}
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
              {#if isMaintainer && onCreateBranch}
                <button 
                  class="menu-item" 
                  onclick={() => { onCreateBranch(); showMoreMenu = false; }} 
                  disabled={needsClone}
                >
                  Create New Branch
                </button>
              {/if}
              {#if isMaintainer && currentBranch && currentBranch !== defaultBranch && onDeleteBranch}
                <button 
                  class="menu-item menu-item-danger" 
                  onclick={() => { 
                    if (currentBranch) {
                      onDeleteBranch(currentBranch);
                    }
                    showMoreMenu = false; 
                  }}
                  title="Delete branch"
                >
                  Delete Branch
                </button>
              {/if}
              {#if onCopyEventId}
                <button class="menu-item" onclick={() => { onCopyEventId(); showMoreMenu = false; }}>
                  Copy Event ID
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
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
  
  {#if repoDescription}
    <p class="repo-description">{repoDescription}</p>
  {/if}

  {#if topics && topics.length > 0}
    <div class="repo-topics">
      {#each topics as topic}
        <span class="topic-tag">{topic}</span>
      {/each}
    </div>
  {/if}

  <div class="repo-meta">
    <div class="repo-owner">
      <button 
        class="owner-badge-button"
        onclick={() => showOwnerMenu = !showOwnerMenu}
        aria-expanded={showOwnerMenu}
        aria-label="Show owners and maintainers"
      >
        <span class="meta-label">Owner:</span>
        <UserBadge pubkey={ownerPubkey} disableLink={true} />
        {#if allMaintainers.length > 1}
          <span class="owner-badge-count">+{allMaintainers.length - 1}</span>
        {/if}
      </button>
      {#if showOwnerMenu && (allMaintainers.length > 0 || ownerPubkey)}
        <div 
          class="owner-menu-overlay" 
          onclick={() => showOwnerMenu = false}
          onkeydown={(e) => {
            if (e.key === 'Escape') {
              showOwnerMenu = false;
            }
          }}
          role="button"
          tabindex="0"
          aria-label="Close menu"
        ></div>
        <div class="owner-menu">
          <div class="owner-menu-header">Owners & Maintainers</div>
          <div class="owner-menu-list">
            {#if allMaintainers.length > 0}
              {#each allMaintainers as maintainer}
                <div 
                  class="owner-menu-item"
                  class:owner-menu-owner={maintainer.isOwner}
                >
                  <UserBadge pubkey={maintainer.pubkey} />
                  {#if maintainer.isOwner}
                    <span class="owner-menu-badge owner">Owner</span>
                  {:else}
                    <span class="owner-menu-badge maintainer">Maintainer</span>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="owner-menu-item owner-menu-owner">
                <UserBadge pubkey={ownerPubkey} />
                <span class="owner-menu-badge owner">Owner</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if branches.length === 0}
      <div class="repo-branch">
        <div class="branch-button" style="opacity: 0.6; cursor: not-allowed;">
          <img src="/icons/git-branch.svg" alt="" class="icon" />
          No branches
        </div>
      </div>
    {:else if currentBranch}
      <div class="repo-branch">
        <button 
          class="branch-button"
          onclick={() => showBranchMenu = !showBranchMenu}
          aria-expanded={showBranchMenu}
        >
          <img src="/icons/git-branch.svg" alt="" class="icon" />
          {currentBranch}
        </button>
        {#if showBranchMenu && branches.length > 0}
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
      </div>
    {/if}
  </div>

</header>
