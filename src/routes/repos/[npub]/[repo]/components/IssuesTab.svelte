<script lang="ts">
  /**
   * Issues tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  import { renderContent } from '../utils/content-renderer.js';
  import NostrHtmlRenderer from '$lib/components/NostrHtmlRenderer.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  
  interface Props {
    issues: Array<{
      id: string;
      subject: string;
      content: string;
      status: string;
      author: string;
      created_at: number;
      kind: number;
      tags?: string[][];
    }>;
    selectedIssue?: string | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: (id: string) => void;
    onStatusUpdate?: (id: string, status: string) => void;
    issueReplies?: Array<any>;
    loadingReplies?: boolean;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
    onCreate?: () => void;
    userPubkey?: string | null;
  }
  
  let {
    issues = [],
    selectedIssue = null,
    loading = false,
    error = null,
    onSelect = () => {},
    onStatusUpdate = () => {},
    issueReplies = [],
    loadingReplies = false,
    activeTab = '',
    tabs = [],
    onTabChange = () => {},
    onCreate,
    userPubkey = null
  }: Props = $props();
  
  const items = $derived(issues.map(issue => ({
    ...issue,
    id: issue.id,
    title: issue.subject,
    status: issue.status || 'open'
  })));
  
  const selectedId = $derived(selectedIssue);
  
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
  <div class="issue-item-content">
    <div class="issue-subject">{item.subject}</div>
    <div class="issue-meta">
      <span class="issue-id">#{item.id.slice(0, 7)}</span>
      <span class="issue-date">{new Date(item.created_at * 1000).toLocaleDateString()}</span>
    </div>
  </div>
{/snippet}

{#snippet detailRenderer({ item }: { item: any })}
  {@const contentPromise = getRenderedContent(item.content || '', item.kind)}
  {@const currentStatus = item.status || 'open'}
  <div class="issue-detail">
    <div class="issue-detail-header">
      <h2>{item.subject}</h2>
      <div class="issue-actions">
        <EventCopyButton eventId={item.id} kind={item.kind} pubkey={(item as any).pubkey} />
        <select 
          value={currentStatus}
          onchange={(e) => onStatusUpdate(item.id, (e.target as HTMLSelectElement).value)}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
    </div>
    
    <div class="issue-content">
      {#await contentPromise}
        <div class="loading">Rendering content...</div>
      {:then html}
        <NostrHtmlRenderer html={html} />
      {:catch err}
        <div class="error">Failed to render content: {err instanceof Error ? err.message : String(err)}</div>
      {/await}
    </div>
    
    {#if loadingReplies}
      <div class="loading">Loading replies...</div>
    {:else if issueReplies.length > 0}
      <div class="issue-replies">
        <h3>Replies</h3>
        {#each issueReplies as reply}
          {@const replyPromise = getRenderedContent(reply.content || '', reply.kind)}
          <div class="reply">
            <div class="reply-header">
              <div class="reply-author">{reply.author}</div>
              <EventCopyButton eventId={reply.id} kind={reply.kind} pubkey={(reply as any).pubkey} />
            </div>
            <div class="reply-content">
              {#await replyPromise}
                <div class="loading">Rendering...</div>
              {:then html}
                <NostrHtmlRenderer html={html} />
              {:catch err}
                {reply.content}
              {/await}
            </div>
            <div class="reply-date">{new Date(reply.created_at * 1000).toLocaleString()}</div>
          </div>
        {/each}
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
    { label: 'Resolved', value: 'resolved' }
  ]}
  {itemRenderer}
  {detailRenderer}
  {activeTab}
  {tabs}
  {onTabChange}
  title="Issues"
  {onCreate}
  showCreateButton={!!userPubkey && !!onCreate}
/>

<style>
  .issue-item-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .issue-subject {
    font-weight: 500;
  }
  
  .issue-meta {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  
  .issue-detail {
    padding: 1rem;
  }
  
  .issue-detail-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }
  
  .issue-detail-header h2 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
  }
  
  .issue-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  
  @media (max-width: 768px) {
    .issue-detail-header {
      flex-direction: column;
      align-items: flex-start;
    }
    
    .issue-detail-header h2 {
      width: 100%;
    }
    
    .issue-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }
  
  .issue-content {
    margin: 1rem 0;
    line-height: 1.6;
  }
  
  .issue-replies {
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border-color);
  }
  
  .reply {
    padding: 1rem;
    margin: 1rem 0;
    border: 1px solid var(--border-color);
    border-radius: 4px;
  }
  
  .reply-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  
  .reply-author {
    font-weight: 500;
  }
  
  .reply-content {
    margin: 0.5rem 0;
  }
  
  .reply-date {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
</style>
