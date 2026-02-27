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
  import { renderContent } from '../utils/content-renderer.js';
  import NostrHtmlRenderer from '$lib/components/NostrHtmlRenderer.svelte';
  
  // Rewrite image paths in HTML to point to repository file API
  function rewriteImagePaths(html: string, filePath: string, npub: string, repo: string, branch: string): string {
    if (!html || !filePath) return html;
    
    // Get the directory of the current file
    const fileDir = filePath.includes('/') 
      ? filePath.substring(0, filePath.lastIndexOf('/'))
      : '';
    
    // Rewrite relative image paths
    return html.replace(/<img([^>]*)\ssrc=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
      // Skip if it's already an absolute URL (http/https/data) or already an API URL
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('/api/')) {
        return match;
      }
      
      // Resolve relative path
      let imagePath: string;
      if (src.startsWith('/')) {
        // Absolute path from repo root
        imagePath = src.substring(1);
      } else if (src.startsWith('./')) {
        // Relative to current file directory
        imagePath = fileDir ? `${fileDir}/${src.substring(2)}` : src.substring(2);
      } else {
        // Relative to current file directory
        imagePath = fileDir ? `${fileDir}/${src}` : src;
      }
      
      // Normalize path (remove .. and .)
      const pathParts = imagePath.split('/').filter(p => p !== '.' && p !== '');
      const normalizedPath: string[] = [];
      for (const part of pathParts) {
        if (part === '..') {
          normalizedPath.pop();
        } else {
          normalizedPath.push(part);
        }
      }
      imagePath = normalizedPath.join('/');
      
      // Build API URL
      const apiUrl = `/api/repos/${npub}/${repo}/raw?path=${encodeURIComponent(imagePath)}&ref=${encodeURIComponent(branch)}`;
      
      return `<img${before} src="${apiUrl}"${after}>`;
    });
  }
  
  interface Props {
    content?: string;
    contentType?: 'markdown' | 'asciidoc' | 'text' | '30040';
    indexEvent?: NostrEvent | null;
    relays?: string[];
    onItemClick?: ((item: any) => void) | null;
    npub?: string;
    repo?: string;
    currentBranch?: string;
    filePath?: string | null;
  }
  
  let {
    content = '',
    contentType = 'text',
    indexEvent = null,
    relays = [],
    onItemClick = null,
    npub = '',
    repo = '',
    currentBranch = 'HEAD',
    filePath = null
  }: Props = $props();
  
  let renderedContent = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  
  $effect(() => {
    // Explicitly track both content and contentType
    const currentContent = content;
    const currentContentType = contentType;
    
    if (currentContentType === '30040' && indexEvent) {
      // Publication index - handled by PublicationIndexViewer
      return;
    }
    
    if (currentContent) {
      // Re-render when content or contentType changes
      doRenderContent();
    }
  });
  
  async function doRenderContent() {
    loading = true;
    error = null;
    
    try {
      logger.operation('Rendering content', { contentType, length: content.length, preview: content.substring(0, 100) });
      
      // Use the shared content renderer utility
      // contentType '30040' is handled separately by PublicationIndexViewer
      if (contentType === '30040') {
        // Should not reach here, but handle gracefully
        renderedContent = '';
      } else {
        renderedContent = await renderContent(content, contentType as 'markdown' | 'asciidoc' | 'text');
        
        logger.debug({ contentType, renderedLength: renderedContent.length, preview: renderedContent.substring(0, 200) }, 'Content rendered');
        
        // Rewrite image paths to use API endpoint
        if (npub && repo && filePath) {
          renderedContent = rewriteImagePaths(renderedContent, filePath, npub, repo, currentBranch);
        }
      }
      
      logger.operation('Content rendered', { contentType, renderedLength: renderedContent.length });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to render content';
      logger.error({ error: err, contentType, contentPreview: content.substring(0, 100) }, 'Error rendering content');
    } finally {
      loading = false;
    }
  }
  
  function handleItemClick(item: any) {
    if (onItemClick) {
      onItemClick(item);
    } else {
      logger.debug({ item }, 'Publication index item clicked');
      // Could navigate to item URL or emit event
      if (item.url) {
        window.open(item.url, '_blank');
      }
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
      <NostrHtmlRenderer html={renderedContent} />
    </div>
  {:else}
    <div class="empty">No content to display</div>
  {/if}
</div>

<style>
  .docs-viewer {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
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
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    line-height: 1.6;
    overflow-wrap: break-word;
    word-wrap: break-word;
  }
  
  .rendered-content :global(img) {
    max-width: 100%;
    height: auto;
    display: block;
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
    max-width: 100%;
    box-sizing: border-box;
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
    max-width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    box-sizing: border-box;
    display: table;
    table-layout: auto;
  }
  
  .rendered-content :global(table) :global(td),
  .rendered-content :global(table) :global(th) {
    word-wrap: break-word;
    overflow-wrap: break-word;
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
