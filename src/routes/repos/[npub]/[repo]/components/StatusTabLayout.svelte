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
    ]
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

<TabLayout {loading} {error}>
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
                  onclick={() => onSelect(item.id)}
                >
                  <slot name="itemRenderer" {item}>
                    <div class="item-title">{item.title}</div>
                    <div class="item-meta">#{item.id.slice(0, 7)}</div>
                  </slot>
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
      <slot name="detailRenderer" item={selectedItem}>
        <div class="detail-view">
          <h2>{selectedItem.title}</h2>
          <pre>{JSON.stringify(selectedItem, null, 2)}</pre>
        </div>
      </slot>
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
  }
  
  .detail-view h2 {
    margin-top: 0;
  }
</style>
