<script lang="ts">
  /**
   * Generic documentation viewer
   * Handles markdown, asciidoc, and kind 30040 publication indexes
   */
  
  import { onMount } from 'svelte';
  import PublicationIndexViewer from '$lib/components/PublicationIndexViewer.svelte';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { KIND } from '$lib/types/nostr.js';
  import logger from '$lib/services/logger.js';
  
  interface Props {
    content?: string;
    contentType?: 'markdown' | 'asciidoc' | 'text' | '30040';
    indexEvent?: NostrEvent | null;
    relays?: string[];
  }
  
  let {
    content = '',
    contentType = 'text',
    indexEvent = null,
    relays = []
  }: Props = $props();
  
  let renderedContent = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  
  $effect(() => {
    if (contentType === '30040' && indexEvent) {
      // Publication index - handled by PublicationIndexViewer
      return;
    }
    
    if (content) {
      renderContent();
    }
  });
  
  async function renderContent() {
    loading = true;
    error = null;
    
    try {
      logger.operation('Rendering content', { contentType, length: content.length });
      
      if (contentType === 'markdown') {
        const MarkdownIt = (await import('markdown-it')).default;
        const hljsModule = await import('highlight.js');
        const hljs = hljsModule.default || hljsModule;
        
        const md = new MarkdownIt({
          highlight: function (str: string, lang: string): string {
            if (lang && hljs.getLanguage(lang)) {
              try {
                return '<pre class="hljs"><code>' +
                       hljs.highlight(str, { language: lang }).value +
                       '</code></pre>';
              } catch (err) {
                // Fallback to escaped HTML
              }
            }
            return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
          }
        });
        
        renderedContent = md.render(content);
        
        // Add IDs to headings for anchor links
        renderedContent = renderedContent.replace(/<h([1-6])>(.*?)<\/h[1-6]>/g, (match, level, text) => {
          const textContent = text.replace(/<[^>]*>/g, '').trim();
          const slug = textContent
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
          
          return `<h${level} id="${slug}">${text}</h${level}>`;
        });
      } else if (contentType === 'asciidoc') {
        const asciidoctor = (await import('asciidoctor')).default();
        renderedContent = asciidoctor.convert(content, {
          safe: 'safe',
          attributes: {
            'source-highlighter': 'highlight.js'
          }
        });
      } else {
        // Plain text - escape HTML
        renderedContent = content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
      }
      
      logger.operation('Content rendered', { contentType });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to render content';
      logger.error({ error: err, contentType }, 'Error rendering content');
    } finally {
      loading = false;
    }
  }
  
  function handleItemClick(item: any) {
    logger.debug({ item }, 'Publication index item clicked');
    // Could navigate to item URL or emit event
    if (item.url) {
      window.open(item.url, '_blank');
    }
  }
</script>

<div class="docs-viewer">
  {#if loading}
    <div class="loading">Rendering content...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if contentType === '30040' && indexEvent}
    <PublicationIndexViewer 
      {indexEvent} 
      {relays}
      onItemClick={handleItemClick}
    />
  {:else if renderedContent}
    <div class="rendered-content" class:markdown={contentType === 'markdown'} class:asciidoc={contentType === 'asciidoc'}>
      {@html renderedContent}
    </div>
  {:else}
    <div class="empty">No content to display</div>
  {/if}
</div>

<style>
  .docs-viewer {
    padding: 1rem;
    max-width: 100%;
  }
  
  .loading, .error, .empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .error {
    color: var(--accent-error);
  }
  
  .rendered-content {
    line-height: 1.6;
  }
  
  .rendered-content :global(h1),
  .rendered-content :global(h2),
  .rendered-content :global(h3),
  .rendered-content :global(h4),
  .rendered-content :global(h5),
  .rendered-content :global(h6) {
    margin-top: 2rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }
  
  .rendered-content :global(h1) {
    font-size: 2rem;
    border-bottom: 2px solid var(--border-color);
    padding-bottom: 0.5rem;
  }
  
  .rendered-content :global(h2) {
    font-size: 1.5rem;
  }
  
  .rendered-content :global(h3) {
    font-size: 1.25rem;
  }
  
  .rendered-content :global(p) {
    margin: 1rem 0;
  }
  
  .rendered-content :global(code) {
    background: var(--bg-secondary);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.9em;
  }
  
  .rendered-content :global(pre) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1rem 0;
  }
  
  .rendered-content :global(pre code) {
    background: none;
    padding: 0;
  }
  
  .rendered-content :global(blockquote) {
    border-left: 4px solid var(--accent-color);
    padding-left: 1rem;
    margin: 1rem 0;
    color: var(--text-secondary);
  }
  
  .rendered-content :global(ul),
  .rendered-content :global(ol) {
    margin: 1rem 0;
    padding-left: 2rem;
  }
  
  .rendered-content :global(li) {
    margin: 0.5rem 0;
  }
  
  .rendered-content :global(a) {
    color: var(--accent-color);
    text-decoration: none;
  }
  
  .rendered-content :global(a:hover) {
    text-decoration: underline;
  }
  
  .rendered-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
  }
  
  .rendered-content :global(th),
  .rendered-content :global(td) {
    border: 1px solid var(--border-color);
    padding: 0.5rem;
    text-align: left;
  }
  
  .rendered-content :global(th) {
    background: var(--bg-secondary);
    font-weight: 600;
  }
</style>
