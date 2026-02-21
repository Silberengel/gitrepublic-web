<script lang="ts">
  import '$lib/styles/components.css';
  interface Props {
    activeTab: string;
    tabs: Array<{ id: string; label: string; icon?: string; count?: number }>;
    onTabChange: (tab: string) => void;
  }

  let { activeTab, tabs, onTabChange }: Props = $props();
  let showMobileMenu = $state(false);
</script>

<nav class="repo-tabs">
  <!-- Mobile tab menu button -->
  <button 
    class="mobile-tabs-menu-button"
    onclick={() => showMobileMenu = !showMobileMenu}
    aria-expanded={showMobileMenu}
    aria-label="Tab menu"
    title={tabs.find(t => t.id === activeTab)?.label || 'Menu'}
  >
    <img src="/icons/menu.svg" alt="" class="icon" />
    <span class="current-tab-label">
      {tabs.find(t => t.id === activeTab)?.label || 'Menu'}
    </span>
  </button>
  
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
