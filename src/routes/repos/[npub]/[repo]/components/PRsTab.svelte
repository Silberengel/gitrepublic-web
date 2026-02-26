<script lang="ts">
  /**
   * Pull Requests tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  
  export let prs: Array<{
    id: string;
    subject: string;
    content: string;
    status: string;
    author: string;
    created_at: number;
    commitId?: string;
    kind: number;
  }> = [];
  export let selectedPR: string | null = null;
  export let loading: boolean = false;
  export let error: string | null = null;
  export let onSelect: (id: string) => void = () => {};
  export let onStatusUpdate: (id: string, status: string) => void = () => {};
  
  const items = $derived(prs.map(pr => ({
    id: pr.id,
    title: pr.subject,
    status: pr.status,
    ...pr
  })));
  
  const selectedId = $derived(selectedPR);
</script>

<StatusTabLayout
  {items}
  {selectedId}
  {loading}
  {error}
  {onSelect}
  statusGroups={[
    { label: 'Open', value: 'open' },
    { label: 'Closed', value: 'closed' },
    { label: 'Merged', value: 'merged' }
  ]}
>
  {#snippet itemRenderer({ item })}
    <div class="pr-item-content">
      <div class="pr-subject">{item.subject}</div>
      <div class="pr-meta">
        <span class="pr-id">#{item.id.slice(0, 7)}</span>
        {#if item.commitId}
          <span class="pr-commit">Commit: {item.commitId.slice(0, 7)}</span>
        {/if}
        <span class="pr-date">{new Date(item.created_at * 1000).toLocaleDateString()}</span>
      </div>
    </div>
  {/snippet}
  
  {#snippet detailRenderer({ item })}
    <div class="pr-detail">
      <div class="pr-detail-header">
        <h2>{item.subject}</h2>
        <div class="pr-actions">
          <select 
            value={item.status}
            onchange={(e) => onStatusUpdate(item.id, (e.target as HTMLSelectElement).value)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="merged">Merged</option>
          </select>
        </div>
      </div>
      
      <div class="pr-content">
        {@html item.content || 'No content'}
      </div>
      
      {#if item.commitId}
        <div class="pr-commit-info">
          <strong>Commit:</strong> {item.commitId}
        </div>
      {/if}
    </div>
  {/snippet}
</StatusTabLayout>

<style>
  .pr-item-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .pr-subject {
    font-weight: 500;
  }
  
  .pr-meta {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  
  .pr-detail {
    padding: 1rem;
  }
  
  .pr-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }
  
  .pr-content {
    margin: 1rem 0;
    line-height: 1.6;
  }
  
  .pr-commit-info {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-family: monospace;
  }
</style>
