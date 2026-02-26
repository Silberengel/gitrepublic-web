<script lang="ts">
  /**
   * Patches tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  
  export let patches: Array<{
    id: string;
    subject: string;
    content: string;
    status: string;
    author: string;
    created_at: number;
    [key: string]: any;
  }> = [];
  export let selectedPatch: string | null = null;
  export let loading: boolean = false;
  export let error: string | null = null;
  export let onSelect: (id: string) => void = () => {};
  export let onApply: (id: string) => void = () => {};
  export let applying: Record<string, boolean> = {};
  
  const items = $derived(patches.map(patch => ({
    id: patch.id,
    title: patch.subject,
    status: patch.status || 'open',
    ...patch
  })));
  
  const selectedId = $derived(selectedPatch);
</script>

<StatusTabLayout
  {items}
  {selectedId}
  {loading}
  {error}
  {onSelect}
  statusGroups={[
    { label: 'Open', value: 'open' },
    { label: 'Applied', value: 'applied' },
    { label: 'Rejected', value: 'rejected' }
  ]}
>
  {#snippet itemRenderer({ item })}
    <div class="patch-item-content">
      <div class="patch-subject">{item.subject}</div>
      <div class="patch-meta">
        <span class="patch-id">#{item.id.slice(0, 7)}</span>
        <span class="patch-date">{new Date(item.created_at * 1000).toLocaleDateString()}</span>
      </div>
    </div>
  {/snippet}
  
  {#snippet detailRenderer({ item })}
    <div class="patch-detail">
      <div class="patch-detail-header">
        <h2>{item.subject}</h2>
        <div class="patch-actions">
          {#if item.status === 'open'}
            <button 
              onclick={() => onApply(item.id)}
              disabled={applying[item.id]}
              class="apply-button"
            >
              {applying[item.id] ? 'Applying...' : 'Apply Patch'}
            </button>
          {/if}
        </div>
      </div>
      
      <div class="patch-content">
        <pre><code>{item.content}</code></pre>
      </div>
    </div>
  {/snippet}
</StatusTabLayout>

<style>
  .patch-item-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .patch-subject {
    font-weight: 500;
  }
  
  .patch-meta {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  
  .patch-detail {
    padding: 1rem;
  }
  
  .patch-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }
  
  .patch-content {
    margin: 1rem 0;
  }
  
  .patch-content pre {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    font-family: monospace;
    font-size: 0.9rem;
  }
  
  .apply-button {
    padding: 0.5rem 1rem;
    background: var(--accent-color);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .apply-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
