<script lang="ts">
  interface Props {
    activeTab: string;
    tabs: Array<{ id: string; label: string; icon?: string; count?: number }>;
    onTabChange: (tab: string) => void;
  }

  let { activeTab, tabs, onTabChange }: Props = $props();
  let showMobileMenu = $state(false);
</script>

<nav class="repo-tabs">
  <div class="tabs-container">
    {#each tabs as tab}
      <button
        class="tab-button"
        class:active={activeTab === tab.id}
        onclick={() => {
          onTabChange(tab.id);
          showMobileMenu = false;
        }}
        aria-current={activeTab === tab.id ? 'page' : undefined}
      >
        {#if tab.icon}
          <img src={tab.icon} alt="" class="tab-icon" />
        {/if}
        <span class="tab-label">{tab.label}</span>
        {#if tab.count !== undefined}
          <span class="tab-count">{tab.count}</span>
        {/if}
      </button>
    {/each}
  </div>
  
  <!-- Mobile menu button -->
  <button 
    class="mobile-menu-button"
    onclick={() => showMobileMenu = !showMobileMenu}
    aria-expanded={showMobileMenu}
    aria-label="Tab menu"
  >
    <img src="/icons/menu.svg" alt="" class="icon" />
    <span class="current-tab-label">
      {tabs.find(t => t.id === activeTab)?.label || 'Menu'}
    </span>
  </button>

  {#if showMobileMenu}
    <div class="mobile-tabs-menu">
      {#each tabs as tab}
        <button
          class="mobile-tab-item"
          class:active={activeTab === tab.id}
          onclick={() => {
            onTabChange(tab.id);
            showMobileMenu = false;
          }}
        >
          {#if tab.icon}
            <img src={tab.icon} alt="" class="tab-icon" />
          {/if}
          <span>{tab.label}</span>
          {#if tab.count !== undefined}
            <span class="tab-count">{tab.count}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</nav>

<style>
  .repo-tabs {
    position: relative;
    background: var(--card-bg, #ffffff);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .tabs-container {
    display: none;
    gap: 0;
  }

  .tab-button {
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    transition: all 0.2s ease;
    position: relative;
  }

  .tab-button:hover {
    color: var(--text-primary, #1a1a1a);
    background: var(--bg-secondary, #f5f5f5);
  }

  .tab-button.active {
    color: var(--accent, #007bff);
    border-bottom-color: var(--accent, #007bff);
    font-weight: 600;
  }

  .tab-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .tab-label {
    display: none;
  }

  .tab-count {
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary, #f5f5f5);
    border-radius: 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary, #666);
  }

  .tab-button.active .tab-count {
    background: var(--accent, #007bff);
    color: var(--accent-text, #ffffff);
  }

  .mobile-menu-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-primary, #1a1a1a);
    font-weight: 500;
  }

  .mobile-menu-button .icon {
    width: 18px;
    height: 18px;
  }

  .current-tab-label {
    flex: 1;
    text-align: left;
  }

  .mobile-tabs-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--card-bg, #ffffff);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    z-index: 50;
    max-height: 70vh;
    overflow-y: auto;
  }

  .mobile-tab-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-primary, #1a1a1a);
    text-align: left;
    transition: background 0.2s ease;
  }

  .mobile-tab-item:hover {
    background: var(--bg-secondary, #f5f5f5);
  }

  .mobile-tab-item.active {
    background: var(--bg-secondary, #f5f5f5);
    color: var(--accent, #007bff);
    font-weight: 600;
  }

  .mobile-tab-item .tab-count {
    margin-left: auto;
  }

  @media (min-width: 768px) {
    .tabs-container {
      display: flex;
    }

    .mobile-menu-button,
    .mobile-tabs-menu {
      display: none;
    }

    .tab-label {
      display: inline;
    }
  }
</style>
