<script lang="ts">
  /**
   * Pull Requests tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  import { renderContent } from '../utils/content-renderer.js';
  import { onMount } from 'svelte';
  
  interface Props {
    prs: Array<{
      id: string;
      subject: string;
      content: string;
      status: string;
      author: string;
      created_at: number;
      commitId?: string;
      kind: number;
    }>;
    selectedPR?: string | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: (id: string) => void;
    onStatusUpdate?: (id: string, status: string) => void;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
  }
  
  let {
    prs = [],
    selectedPR = null,
    loading = false,
    error = null,
    onSelect = () => {},
    onStatusUpdate = () => {},
    activeTab = '',
    tabs = [],
    onTabChange = () => {}
  }: Props = $props();
  
  const items = $derived(prs.map(pr => ({
    ...pr,
    id: pr.id,
    title: pr.subject,
    status: pr.status || 'open'
  })));
  
  const selectedId = $derived(selectedPR);
  
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

{#snippet detailRenderer({ item }: { item: any })}
  {@const contentPromise = getRenderedContent(item.content || '', item.kind)}
  {@const currentStatus = item.status || 'open'}
  <div class="pr-detail">
    <div class="pr-detail-header">
      <h2>{item.subject}</h2>
      <div class="pr-actions">
        <select 
          value={currentStatus}
          onchange={(e) => onStatusUpdate(item.id, (e.target as HTMLSelectElement).value)}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="merged">Merged</option>
        </select>
      </div>
    </div>
    
    <div class="pr-content">
      {#await contentPromise}
        <div class="loading">Rendering content...</div>
      {:then html}
        {@html html}
      {:catch err}
        <div class="error">Failed to render content: {err instanceof Error ? err.message : String(err)}</div>
      {/await}
    </div>
    
    {#if item.commitId}
      <div class="pr-commit-info">
        <strong>Commit:</strong> {item.commitId}
      </div>
    {/if}
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
    { label: 'Closed', value: 'closed' },
    { label: 'Merged', value: 'merged' }
  ]}
  {itemRenderer}
  {detailRenderer}
  {activeTab}
  {tabs}
  {onTabChange}
  title="Pull Requests"
/>

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
