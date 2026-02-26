<script lang="ts">
  /**
   * Hierarchical tab layout component
   * Provides left-pane/right-panel structure for all tabs
   */
  
  interface Props {
    leftPane?: any;
    rightPanel?: any;
    loading?: boolean;
    error?: string | null;
  }
  
  let {
    leftPane = null,
    rightPanel = null,
    loading = false,
    error = null
  }: Props = $props();
</script>

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

<style>
  .tab-layout {
    display: flex;
    height: 100%;
    gap: 1rem;
  }
  
  .left-pane {
    flex: 0 0 300px;
    border-right: 1px solid var(--border-color);
    overflow-y: auto;
    padding: 1rem;
  }
  
  .right-panel {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
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
    height: 100%;
    color: var(--text-secondary);
  }
</style>
