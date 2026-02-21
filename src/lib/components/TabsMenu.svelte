<script lang="ts">
  import '$lib/styles/components.css';
  
  interface Props {
    activeTab: string;
    tabs: Array<{ id: string; label: string; icon?: string; count?: number }>;
    onTabChange: (tab: string) => void;
  }

  let { activeTab, tabs, onTabChange }: Props = $props();
  let showTabsMenu = $state(false);
</script>

<div class="tabs-menu-button-wrapper">
  <div class="menu-button-wrapper">
    <button 
      class="menu-button" 
      onclick={() => showTabsMenu = !showTabsMenu}
      aria-label="Tabs menu"
      title="View tabs"
    >
      <img src="/icons/more-vertical.svg" alt="" class="icon" />
    </button>
    {#if showTabsMenu}
      <div 
        class="more-menu-overlay" 
        onclick={() => showTabsMenu = false}
        onkeydown={(e) => {
          if (e.key === 'Escape') {
            showTabsMenu = false;
          }
        }}
        role="button"
        tabindex="0"
        aria-label="Close menu"
      ></div>
      <div class="more-menu tabs-menu">
        {#each tabs as tab}
          <button
            class="menu-item"
            class:active={activeTab === tab.id}
            onclick={() => {
              onTabChange(tab.id);
              showTabsMenu = false;
            }}
          >
            {#if tab.icon}
              <img src={tab.icon} alt="" class="tab-icon-inline" />
            {/if}
            {tab.label}
            {#if tab.count !== undefined}
              <span class="tab-count-inline">{tab.count}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
