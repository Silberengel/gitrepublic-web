<script lang="ts">
  /**
   * Patches tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  import { renderContent } from '../utils/content-renderer.js';
  
  interface Props {
    patches: Array<{
      id: string;
      subject: string;
      content: string;
      status: string;
      author: string;
      created_at: number;
      kind?: number;
      [key: string]: any;
    }>;
    selectedPatch?: string | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: (id: string) => void;
    onApply?: (id: string) => void;
    onStatusUpdate?: (id: string, status: string) => void;
    applying?: Record<string, boolean>;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
  }
  
  let {
    patches = [],
    selectedPatch = null,
    loading = false,
    error = null,
    onSelect = () => {},
    onApply = () => {},
    onStatusUpdate = () => {},
    applying = {},
    activeTab = '',
    tabs = [],
    onTabChange = () => {}
  }: Props = $props();
  
  const items = $derived(patches.map(patch => ({
    ...patch,
    id: patch.id,
    title: patch.subject,
    status: patch.status || 'open'
  })));
  
  const selectedId = $derived(selectedPatch);
  
  // Cache for rendered content
  let renderedContent = $state<Map<string, string>>(new Map());
  
  async function getRenderedContent(content: string, kind?: number): Promise<string> {
    if (!content) return 'No content';
    const cacheKey = `${kind || 'markdown'}:${content.slice(0, 50)}`;
    if (renderedContent.has(cacheKey)) {
      return renderedContent.get(cacheKey)!;
    }
    const rendered = await renderContent(content, kind);
    renderedContent.set(cacheKey, rendered);
    return rendered;
  }
</script>

{#snippet itemRenderer({ item }: { item: any })}
  <div class="patch-item-content">
    <div class="patch-subject">{item.subject}</div>
    <div class="patch-meta">
      <span class="patch-id">#{item.id.slice(0, 7)}</span>
      <span class="patch-date">{new Date(item.created_at * 1000).toLocaleDateString()}</span>
    </div>
  </div>
{/snippet}

{#snippet detailRenderer({ item }: { item: any })}
  {@const contentPromise = getRenderedContent(item.content || '', item.kind)}
  {@const currentStatus = item.status || 'open'}
  <div class="patch-detail">
    <div class="patch-detail-header">
      <h2>{item.subject}</h2>
      <div class="patch-actions">
        <select 
          value={currentStatus}
          onchange={(e) => onStatusUpdate(item.id, (e.target as HTMLSelectElement).value)}
          class="status-select"
        >
          <option value="open">Open</option>
          <option value="applied">Applied</option>
          <option value="rejected">Rejected</option>
        </select>
        {#if currentStatus === 'open'}
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
      {#await contentPromise}
        <div class="loading">Rendering content...</div>
      {:then html}
        {@html html}
      {:catch err}
        <div class="error">Failed to render content: {err instanceof Error ? err.message : String(err)}</div>
      {/await}
    </div>
  </div>
{/snippet}

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
  {itemRenderer}
  {detailRenderer}
  {activeTab}
  {tabs}
  {onTabChange}
  title="Patches"
/>

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
    line-height: 1.6;
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
  
  .status-select {
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    margin-right: 0.5rem;
  }
</style>
