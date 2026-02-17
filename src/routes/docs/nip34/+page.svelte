<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';

  let content = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const docContent = $page.data.content;
      if (docContent) {
        const MarkdownIt = (await import('markdown-it')).default;
        const hljsModule = await import('highlight.js');
        const hljs = hljsModule.default || hljsModule;
        
        const md: any = new MarkdownIt({
          highlight: function (str: string, lang: string): string {
            if (lang && hljs.getLanguage(lang)) {
              try {
                return '<pre class="hljs"><code>' +
                       hljs.highlight(str, { language: lang }).value +
                       '</code></pre>';
              } catch (__) {}
            }
            return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
          }
        });
        
        content = md.render(docContent);
      } else {
        error = $page.data.error || 'Failed to load NIP-34 documentation';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load documentation';
      console.error('Error parsing NIP-34.md:', err);
    } finally {
      loading = false;
    }
  });
</script>

<div class="container">
  <header>
    <a href="/" class="back-link">← Back to Repositories</a>
    <h1>NIP-34 Documentation</h1>
    <p class="subtitle">Git collaboration using Nostr</p>
  </header>

  <main class="docs-content">
    {#if loading}
      <div class="loading">Loading documentation...</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else}
      <div class="markdown-content">
        {@html content}
      </div>
    {/if}
  </main>
</div>

<style>
  .container {
    max-width: 1000px;
    margin: 0 auto;
    padding: 2rem;
  }

  header {
    margin-bottom: 2rem;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 1rem;
  }

  .back-link {
    color: #3b82f6;
    text-decoration: none;
    font-size: 0.875rem;
    display: inline-block;
    margin-bottom: 0.5rem;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
  }

  .subtitle {
    color: #6b7280;
    margin: 0;
  }

  .docs-content {
    background: white;
    padding: 2rem;
    border-radius: 0.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .loading, .error {
    text-align: center;
    padding: 2rem;
  }

  .error {
    color: #dc2626;
    background: #fee2e2;
    border-radius: 0.5rem;
  }

  :global(.markdown-content) {
    line-height: 1.6;
  }

  :global(.markdown-content h1) {
    font-size: 2rem;
    margin-top: 2rem;
    margin-bottom: 1rem;
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 0.5rem;
  }

  :global(.markdown-content h2) {
    font-size: 1.5rem;
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    color: #1f2937;
  }

  :global(.markdown-content h3) {
    font-size: 1.25rem;
    margin-top: 1.25rem;
    margin-bottom: 0.5rem;
    color: #374151;
  }

  :global(.markdown-content code) {
    background: #f3f4f6;
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: 'Courier New', monospace;
    font-size: 0.875em;
  }

  :global(.markdown-content pre) {
    background: #1f2937;
    color: #f9fafb;
    padding: 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin: 1rem 0;
  }

  :global(.markdown-content pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
  }

  :global(.markdown-content p) {
    margin: 1rem 0;
  }

  :global(.markdown-content ul, .markdown-content ol) {
    margin: 1rem 0;
    padding-left: 2rem;
  }

  :global(.markdown-content li) {
    margin: 0.5rem 0;
  }

  :global(.markdown-content blockquote) {
    border-left: 4px solid #3b82f6;
    padding-left: 1rem;
    margin: 1rem 0;
    color: #6b7280;
  }

  :global(.markdown-content table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
  }

  :global(.markdown-content th, .markdown-content td) {
    border: 1px solid #e5e7eb;
    padding: 0.5rem;
    text-align: left;
  }

  :global(.markdown-content th) {
    background: #f9fafb;
    font-weight: 600;
  }
</style>
