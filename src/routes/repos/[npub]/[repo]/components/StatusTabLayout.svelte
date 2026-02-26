<script lang="ts">
  /**
   * Status-based tab layout for issues, patches, and PRs
   * Groups items by status (open, closed, etc.)
   */
  
  import TabLayout from './TabLayout.svelte';
  
  interface Props {
    items?: Array<{
      id: string;
      title: string;
      status: string;
      [key: string]: any;
    }>;
    selectedId?: string | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: (id: string) => void;
    statusGroups?: Array<{ label: string; value: string }>;
    itemRenderer?: import('svelte').Snippet<[{ item: { id: string; title: string; status: string; [key: string]: any } }]>;
    detailRenderer?: import('svelte').Snippet<[{ item: { id: string; title: string; status: string; [key: string]: any } }]>;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
    title?: string;
  }
  
  let {
    items = [],
    selectedId = null,
    loading = false,
    error = null,
    onSelect = () => {},
    statusGroups = [
      { label: 'Open', value: 'open' },
      { label: 'Closed', value: 'closed' }
    ],
    itemRenderer,
    detailRenderer,
    activeTab = '',
    tabs = [],
    onTabChange = () => {},
    title = ''
  }: Props = $props();
  
  let selectedItem = $derived(items.find(item => item.id === selectedId) || null);
  
  function groupByStatus() {
    const grouped: Record<string, typeof items> = {};
    statusGroups.forEach(group => {
      grouped[group.value] = [];
    });
    
    items.forEach(item => {
      const status = item.status || 'open';
      if (!grouped[status]) {
        grouped[status] = [];
      }
      grouped[status].push(item);
    });
    
    return grouped;
  }
  
  const grouped = $derived(groupByStatus());
</script>

<TabLayout 
  {loading} 
  {error}
  {activeTab}
  {tabs}
  {onTabChange}
  {title}
>
  {#snippet leftPane()}
    <div class="status-groups">
      {#each statusGroups as { label, value }}
        {#if grouped[value] && grouped[value].length > 0}
          <div class="status-group">
            <h3 class="status-header">{label} ({grouped[value].length})</h3>
            <div class="items-list">
              {#each grouped[value] as item}
                <div 
                  class="item {selectedId === item.id ? 'selected' : ''}"
                  role="button"
                  tabindex="0"
                  onclick={() => onSelect(item.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(item.id);
                    }
                  }}
                >
                  {#if itemRenderer}
                    {@render itemRenderer({ item })}
                  {:else}
                    <div class="item-title">{item.title}</div>
                    <div class="item-meta">#{item.id.slice(0, 7)}</div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/snippet}
  
  {#snippet rightPanel()}
    {#if selectedItem}
      {#if detailRenderer}
        {@render detailRenderer({ item: selectedItem })}
      {:else}
        <div class="detail-view">
          <h2>{selectedItem.title}</h2>
          <pre>{JSON.stringify(selectedItem, null, 2)}</pre>
        </div>
      {/if}
    {:else}
      <div class="empty-state">
        <p>Select an item to view details</p>
      </div>
    {/if}
  {/snippet}
</TabLayout>

<style>
  .status-groups {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  
  .status-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .status-header {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
    padding: 0.5rem 0;
  }
  
  .items-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .item {
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .item:hover {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }
  
  .item.selected {
    background: var(--bg-selected);
    border-color: var(--accent-color);
  }
  
  .item-title {
    font-weight: 500;
    margin-bottom: 0.25rem;
  }
  
  .item-meta {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  
  .detail-view {
    padding: 1rem;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  
  .detail-view h2 {
    margin-top: 0;
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
