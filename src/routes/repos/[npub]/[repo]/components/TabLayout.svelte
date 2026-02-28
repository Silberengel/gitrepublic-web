<script lang="ts">
  /**
   * Hierarchical tab layout component
   * Provides left-pane/right-panel structure for all tabs
   */
  
  import TabsMenu from '$lib/components/TabsMenu.svelte';
  
  interface Props {
    leftPane?: any;
    rightPanel?: any;
    loading?: boolean;
    error?: string | null;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
    title?: string;
  }
  
  let {
    leftPane = null,
    rightPanel = null,
    loading = false,
    error = null,
    activeTab = '',
    tabs = [],
    onTabChange = () => {},
    title = ''
  }: Props = $props();
</script>

<div class="tab-layout-wrapper">
  {#if tabs.length > 0}
    <div class="tab-header">
      <TabsMenu 
        activeTab={activeTab || ''} 
        {tabs} 
        onTabChange={(tab) => onTabChange(tab)}
      />
      {#if title}
        <h2 class="tab-title">{title}</h2>
      {/if}
    </div>
  {/if}
  
  <div class="tab-layout">
    <div class="left-pane">
      {#if loading}
        <div class="loading">Loading...</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else}
        {#if leftPane}
          {@render leftPane()}
        {/if}
      {/if}
    </div>
    
    <div class="right-panel">
      {#if rightPanel}
        {@render rightPanel()}
      {:else}
        <div class="empty-state">
          <p>Select an item to view details</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .tab-layout-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  
  .tab-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--bg-primary);
    flex-shrink: 0;
    width: 100%;
    box-sizing: border-box;
  }
  
  .tab-title {
    flex: 1;
    margin: 0;
    font-size: 1.2rem;
    color: var(--text-primary);
    min-width: 0;
  }
  
  .tab-layout {
    display: flex;
    flex: 1;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    gap: 1rem;
    box-sizing: border-box;
    min-height: 600px; /* Ensure minimum height so content isn't cut off */
  }
  
  .left-pane {
    flex: 0 0 400px;
    min-width: 400px;
    max-width: 400px;
    border-right: 1px solid var(--border-color);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1rem;
    box-sizing: border-box;
    background: var(--bg-primary);
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
  }
  
  .left-pane > * {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  
  .right-panel {
    flex: 1 1 auto;
    min-width: 400px;
    width: auto;
    max-width: none;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--bg-primary);
    color: var(--text-primary);
  }
  
  .right-panel > * {
    min-width: 0;
    max-width: 100%;
    width: 100%;
    flex: 1;
    box-sizing: border-box;
  }
  
  .loading, .error {
    padding: 2rem;
    text-align: center;
  }
  
  .error {
    color: var(--accent-error);
  }
  
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-width: 100%;
    max-width: 100%;
    height: 100%;
    color: var(--text-secondary);
    box-sizing: border-box;
  }
</style>
