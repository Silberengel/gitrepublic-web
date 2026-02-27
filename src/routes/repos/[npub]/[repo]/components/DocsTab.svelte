<script lang="ts">
  /**
   * Documentation tab component
   * Handles markdown, asciidoc, and kind 30040 publication indexes
   */
  
  import TabLayout from './TabLayout.svelte';
  import DocsViewer from './DocsViewer.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { KIND } from '$lib/types/nostr.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import logger from '$lib/services/logger.js';
  import { extractAsciiDocTitle } from '../utils/content-renderer.js';
  
  interface Props {
    npub?: string;
    repo?: string;
    currentBranch?: string | null;
    relays?: string[];
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
    isMaintainer?: boolean;
    onCreateDocumentation?: () => void;
    reloadTrigger?: number; // Changes when documentation is created to trigger reload
  }
  
  let {
    npub = '',
    repo = '',
    currentBranch = null,
    relays = DEFAULT_NOSTR_RELAYS,
    activeTab = '',
    tabs = [],
    onTabChange = () => {},
    isMaintainer = false,
    onCreateDocumentation = () => {},
    reloadTrigger = 0
  }: Props = $props();
  
  let documentationContent = $state<string | null>(null);
  let documentationKind = $state<'markdown' | 'asciidoc' | 'text' | '30040' | null>(null);
  let documentationTitle = $state<string | null>(null);
  let indexEvent = $state<NostrEvent | null>(null);
  let loading = $state(false);
  let loadingDocs = $state(false);
  let error = $state<string | null>(null);
  let docFiles: Array<{ name: string; path: string }> = $state([]);
  let selectedDoc: string | null = $state(null);
  let hasReadme = $state(false);
  let nostrDocs: Array<{ id: string; title: string; kind: number; event: NostrEvent }> = $state([]);
  
  $effect(() => {
    if (npub && repo && currentBranch) {
      loadDocumentation();
    }
  });

  // Reload when reloadTrigger changes (e.g., after creating documentation)
  $effect(() => {
    if (reloadTrigger > 0 && npub && repo && currentBranch) {
      loadDocumentation();
    }
  });
  
  async function loadDocumentation() {
    loading = true;
    loadingDocs = true;
    error = null;
    documentationContent = null;
    documentationKind = null;
    documentationTitle = null; // Clear any previous title
    indexEvent = null;
    hasReadme = false;
    
    try {
      logger.operation('Loading documentation', { npub, repo, branch: currentBranch });
      
      // Load README FIRST and display immediately
      try {
        const readmeResponse = await fetch(`/api/repos/${npub}/${repo}/readme?ref=${currentBranch || 'HEAD'}`);
        if (readmeResponse.ok) {
          const readmeData = await readmeResponse.json();
          if (readmeData.content) {
            documentationContent = readmeData.content;
            documentationKind = readmeData.type || 'markdown';
            selectedDoc = 'README.md';
            hasReadme = true;
            loading = false; // Stop showing loading once README is loaded
            logger.debug({ npub, repo }, 'README loaded and displayed');
          }
        }
      } catch (readmeErr) {
        logger.debug({ error: readmeErr, npub, repo }, 'No README found');
      }
      
      // Now check for docs folder in the background
      try {
        const response = await fetch(`/api/repos/${npub}/${repo}/tree?ref=${currentBranch || 'HEAD'}&path=docs`);
        if (response.ok) {
          const data = await response.json();
          const docsFiles = Array.isArray(data) ? data : (data.files || []);
          
          if (docsFiles.length > 0) {
            docFiles = docsFiles;
            logger.debug({ npub, repo, fileCount: docsFiles.length }, 'Docs folder found');
          }
        }
      } catch (err) {
        logger.debug({ error: err, npub, repo }, 'Docs folder not found');
      }
      
      // Check for kind 30040 publication index (only if no README found)
      if (!hasReadme && !indexEvent) {
        await checkForPublicationIndex();
        if (indexEvent) {
          loading = false;
        }
      }
      
      // Load Nostr documentation events (kind 30818, 30041, 30817, 30023)
      await loadNostrDocumentation();
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load documentation';
      logger.error({ error: err, npub, repo }, 'Error loading documentation');
      loading = false;
    } finally {
      loadingDocs = false;
      if (!hasReadme && !indexEvent) {
        loading = false;
      }
    }
  }
  
  async function loadDocFile(path: string) {
    try {
      // Clear any Nostr doc state when loading a file
      documentationTitle = null;
      indexEvent = null;
      
      const response = await fetch(`/api/repos/${npub}/${repo}/raw?path=${encodeURIComponent(path)}&ref=${currentBranch || 'HEAD'}`);
      if (response.ok) {
        const content = await response.text();
        documentationContent = content;
        
        // Determine type from extension
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext === 'md' || ext === 'markdown') {
          documentationKind = 'markdown';
        } else if (ext === 'adoc' || ext === 'asciidoc') {
          documentationKind = 'asciidoc';
          // Extract title for AsciiDoc files too
          const extractedTitle = extractAsciiDocTitle(content);
          if (extractedTitle) {
            documentationTitle = extractedTitle;
          }
        } else {
          documentationKind = 'text';
        }
        
        selectedDoc = path;
      }
    } catch (err) {
      logger.warn({ error: err, path }, 'Failed to load doc file');
    }
  }
  
  async function checkForPublicationIndex() {
    try {
      // Look for kind 30040 events in the repo announcement
      const { requireNpubHex } = await import('$lib/utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHex(npub);
      
      const client = new NostrClient(relays);
      const events = await client.fetchEvents([
        {
          kinds: [30040],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);
      
      if (events.length > 0) {
        indexEvent = events[0];
        documentationKind = '30040';
        logger.debug({ eventId: indexEvent.id }, 'Found kind 30040 publication index');
      }
    } catch (err) {
      logger.debug({ error: err }, 'No kind 30040 index found or error checking');
    }
  }

  async function loadNostrDocumentation() {
    try {
      const { requireNpubHex } = await import('$lib/utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHex(npub);
      const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;
      
      const client = new NostrClient(relays);
      // Load documentation events: 30818 (Repository State), 30041 (Publication), 30817 (Repository Announcement), 30023 (Article)
      const events = await client.fetchEvents([
        {
          kinds: [30818, 30041, 30817, 30023],
          authors: [repoOwnerPubkey],
          '#a': [repoAddress],
          limit: 100
        }
      ]);
      
      nostrDocs = events.map(event => {
        const titleTag = event.tags.find(t => t[0] === 'title');
        const title = titleTag?.[1] || `Documentation (kind ${event.kind})`;
        return {
          id: event.id,
          title,
          kind: event.kind,
          event
        };
      });
      
      logger.debug({ count: nostrDocs.length }, 'Loaded Nostr documentation events');
    } catch (err) {
      logger.debug({ error: err }, 'Error loading Nostr documentation events');
    }
  }

  function loadNostrDoc(doc: { id: string; title: string; kind: number; event: NostrEvent }) {
    // Clear previous content first to ensure re-render
    documentationContent = null;
    documentationKind = null;
    documentationTitle = null;
    
    // Set new content and type
    documentationContent = doc.event.content;
    // Determine content type based on kind
    if (doc.kind === 30041 || doc.kind === 30818) {
      documentationKind = 'asciidoc';
      // Extract document title from AsciiDoc
      const extractedTitle = extractAsciiDocTitle(doc.event.content);
      documentationTitle = extractedTitle || doc.title;
    } else {
      documentationKind = 'markdown';
      documentationTitle = doc.title;
    }
    selectedDoc = `nostr:${doc.id}`;
    indexEvent = null; // Clear index event if viewing a doc
    
    logger.debug({ 
      docId: doc.id, 
      kind: doc.kind, 
      contentType: documentationKind, 
      title: documentationTitle,
      contentLength: doc.event.content.length,
      contentPreview: doc.event.content.substring(0, 50)
    }, 'Loading Nostr documentation');
  }
  
  function handleItemClick(item: any) {
    if (item.url) {
      window.open(item.url, '_blank');
    } else if (item.path) {
      loadDocFile(item.path);
    }
  }
</script>

<TabLayout 
  {loading} 
  {error}
  {activeTab}
  {tabs}
  {onTabChange}
  title="Documentation"
>
  {#snippet leftPane()}
    <div class="docs-sidebar">
      <div class="docs-header">
        <h3>Documentation</h3>
        {#if isMaintainer && onCreateDocumentation}
          <button 
            onclick={onCreateDocumentation}
            class="create-doc-button"
            title="Create Documentation Event"
          >
            <img src="/icons/plus.svg" alt="New" class="icon" />
          </button>
        {/if}
      </div>
      {#if loadingDocs}
        <div class="loading">Loading...</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else}
        <ul class="doc-list">
          {#if hasReadme}
            <li>
              <button 
                class="doc-item {selectedDoc === 'README.md' ? 'selected' : ''}"
                onclick={() => {
                  // Always reload README to ensure we have the right content
                  // Clear any Nostr doc state first
                  documentationTitle = null;
                  indexEvent = null;
                  loadDocumentation();
                }}
              >
                README.md
              </button>
            </li>
          {/if}
          {#if docFiles.length > 0}
            {#each docFiles as file}
              <li>
                <button 
                  class="doc-item {selectedDoc === file.path ? 'selected' : ''}"
                  onclick={() => loadDocFile(file.path)}
                >
                  {file.name}
                </button>
              </li>
            {/each}
          {/if}
          {#if nostrDocs.length > 0}
            {#each nostrDocs as doc}
              <li class="nostr-doc-item">
                <button 
                  class="doc-item {selectedDoc === `nostr:${doc.id}` ? 'selected' : ''}"
                  onclick={() => loadNostrDoc(doc)}
                  title="Kind {doc.kind}"
                >
                  {doc.title}
                </button>
                <EventCopyButton 
                  eventId={doc.id} 
                  kind={doc.kind} 
                  pubkey={doc.event.pubkey} 
                />
              </li>
            {/each}
          {/if}
          {#if !hasReadme && docFiles.length === 0 && nostrDocs.length === 0}
            <div class="empty-sidebar">
              <p>No documentation files found</p>
            </div>
          {/if}
        </ul>
      {/if}
    </div>
  {/snippet}
  
  {#snippet rightPanel()}
    {#if loading}
      <div class="loading">Loading documentation...</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else if documentationKind === '30040' && indexEvent}
      <DocsViewer
        contentType="30040"
        {indexEvent}
        {relays}
        onItemClick={handleItemClick}
      />
    {:else if documentationContent}
      <div class="docs-panel">
        {#if documentationTitle}
          <div class="docs-panel-header">
            <h2 class="docs-panel-title">{documentationTitle}</h2>
          </div>
        {/if}
        <DocsViewer
          content={documentationContent}
          contentType={documentationKind || 'text'}
          npub={npub}
          repo={repo}
          currentBranch={currentBranch || 'HEAD'}
          filePath={selectedDoc || 'README.md'}
        />
      </div>
    {:else}
      <div class="empty-docs">
        <p>No documentation found</p>
        <p class="hint">Add a README.md, README.adoc, or docs/ folder to your repository</p>
      </div>
    {/if}
  {/snippet}
</TabLayout>

<style>
  .docs-sidebar {
    width: 100%;
    max-width: 100%;
    height: 100%;
    padding: 0;
    color: var(--text-primary);
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  
  .docs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color);
    width: 100%;
    box-sizing: border-box;
  }

  .docs-sidebar h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .create-doc-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    transition: opacity 0.2s;
  }

  .create-doc-button:hover {
    opacity: 0.7;
  }

  .create-doc-button .icon {
    width: 20px;
    height: 20px;
    filter: var(--icon-filter, none);
  }
  
  .doc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    width: 100%;
    box-sizing: border-box;
    flex: 1;
    overflow-y: auto;
  }

  .nostr-doc-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .nostr-doc-item .doc-item {
    flex: 1;
    margin-bottom: 0;
  }
  
  .doc-item {
    width: 100%;
    padding: 0.75rem;
    text-align: left;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    margin-bottom: 0.5rem;
    cursor: pointer;
    transition: all 0.2s;
    color: var(--text-primary);
    font-family: inherit;
    font-size: inherit;
  }
  
  .doc-item:hover {
    background: var(--bg-hover);
    border-color: var(--accent-color);
    color: var(--text-primary);
  }
  
  .doc-item.selected {
    background: var(--bg-selected);
    border-color: var(--accent-color);
    color: var(--text-primary);
    font-weight: 500;
  }
  
  .empty-docs {
    padding: 3rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .hint {
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }
  
  .empty-sidebar {
    padding: 1rem;
    text-align: center;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  
  .loading {
    padding: 1rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .error {
    padding: 1rem;
    background: var(--error-bg, #ffebee);
    color: var(--error-color, #c62828);
    border-radius: 4px;
    margin: 1rem;
  }

  .docs-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .docs-panel-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 1rem;
    flex-shrink: 0;
  }

  .docs-panel-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text-primary);
  }
</style>
