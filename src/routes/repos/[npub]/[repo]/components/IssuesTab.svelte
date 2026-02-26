<script lang="ts">
  /**
   * Issues tab component using hierarchical layout
   */
  
  import StatusTabLayout from './StatusTabLayout.svelte';
  
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
  }
  
  let {
    issues = [],
    selectedIssue = null,
    loading = false,
    error = null,
    onSelect = () => {},
    onStatusUpdate = () => {},
    issueReplies = [],
    loadingReplies = false
  }: Props = $props();
  
  const items = $derived(issues.map(issue => ({
    id: issue.id,
    title: issue.subject,
    status: issue.status,
    ...issue
  })));
  
  const selectedId = $derived(selectedIssue);
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
    { label: 'Resolved', value: 'resolved' }
  ]}
>
  {#snippet itemRenderer({ item })}
    <div class="issue-item-content">
      <div class="issue-subject">{item.subject}</div>
      <div class="issue-meta">
        <span class="issue-id">#{item.id.slice(0, 7)}</span>
        <span class="issue-date">{new Date(item.created_at * 1000).toLocaleDateString()}</span>
      </div>
    </div>
  {/snippet}
  
  {#snippet detailRenderer({ item })}
    <div class="issue-detail">
      <div class="issue-detail-header">
        <h2>{item.subject}</h2>
        <div class="issue-actions">
          <select 
            value={item.status}
            onchange={(e) => onStatusUpdate(item.id, (e.target as HTMLSelectElement).value)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>
      
      <div class="issue-content">
        {@html item.content || 'No content'}
      </div>
      
      {#if loadingReplies}
        <div class="loading">Loading replies...</div>
      {:else if issueReplies.length > 0}
        <div class="issue-replies">
          <h3>Replies</h3>
          {#each issueReplies as reply}
            <div class="reply">
              <div class="reply-author">{reply.author}</div>
              <div class="reply-content">{reply.content}</div>
              <div class="reply-date">{new Date(reply.created_at * 1000).toLocaleString()}</div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}
</StatusTabLayout>

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
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
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
  
  .reply-author {
    font-weight: 500;
    margin-bottom: 0.5rem;
  }
  
  .reply-content {
    margin: 0.5rem 0;
  }
  
  .reply-date {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
</style>
