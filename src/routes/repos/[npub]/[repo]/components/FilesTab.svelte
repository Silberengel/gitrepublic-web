<script lang="ts">
  /**
   * Files tab component
   * Handles file browser and editor
   */
  
  import TabLayout from './TabLayout.svelte';
  import FileBrowser from './FileBrowser.svelte';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import NostrHtmlRenderer from '$lib/components/NostrHtmlRenderer.svelte';
  
  interface Props {
    files?: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>;
    currentPath?: string;
    currentFile?: string | null;
    fileContent?: string;
    fileLanguage?: 'markdown' | 'asciidoc' | 'text';
    editedContent?: string;
    hasChanges?: boolean;
    loading?: boolean;
    error?: string | null;
    pathStack?: string[];
    onFileClick?: (file: { name: string; path: string; type: 'file' | 'directory' }) => void;
    onDirectoryClick?: (path: string) => void;
    onNavigateBack?: () => void;
    onContentChange?: (content: string) => void;
    isMaintainer?: boolean;
    showFilePreview?: boolean;
    fileHtml?: string | null;
    highlightedFileContent?: string | null;
    isImageFile?: boolean;
    imageUrl?: string | null;
    wordWrap?: boolean;
    supportsPreview?: (ext: string) => boolean;
    onSave?: () => void;
    onTogglePreview?: () => void;
    onCopyFileContent?: (e: Event) => void;
    onDownloadFile?: () => void;
    copyingFile?: boolean;
    saving?: boolean;
    needsClone?: boolean;
    cloneTooltip?: string;
    branches?: Array<string | { name: string }>;
    currentBranch?: string | null;
    defaultBranch?: string | null;
    onBranchChange?: (branch: string) => void;
    userPubkey?: string | null;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
    onCreateFile?: () => void;
    onApplySyntaxHighlighting?: (content: string, ext: string) => Promise<void>;
  }
  
  let {
    files = [],
    currentPath = '',
    currentFile = null,
    fileContent = '',
    fileLanguage = 'text',
    editedContent = '',
    hasChanges = false,
    loading = false,
    error = null,
    pathStack = [],
    onFileClick = () => {},
    onDirectoryClick = () => {},
    onNavigateBack = () => {},
    onContentChange = () => {},
    isMaintainer = false,
    showFilePreview = false,
    fileHtml = null,
    highlightedFileContent = null,
    isImageFile = false,
    imageUrl = null,
    wordWrap = false,
    supportsPreview = () => false,
    onSave = () => {},
    onTogglePreview = () => {},
    onCopyFileContent = () => {},
    onDownloadFile = () => {},
    copyingFile = false,
    saving = false,
    needsClone = false,
    cloneTooltip = '',
    branches = [],
    currentBranch = null,
    defaultBranch = null,
    onBranchChange = () => {},
    userPubkey = null,
    activeTab = '',
    tabs = [],
    onTabChange = () => {},
    onCreateFile = () => {},
    onApplySyntaxHighlighting = async () => {}
  }: Props = $props();

  // Apply syntax highlighting when fileContent changes and we're showing raw content
  // This ensures highlighting is ALWAYS applied for raw files, regardless of maintainer status
  $effect(() => {
    // Only apply highlighting when:
    // 1. We have file content
    // 2. We have a current file
    // 3. We're NOT in preview mode (showing raw)
    // 4. It's NOT an image
    // 5. Content is not empty
    if (fileContent && currentFile && !showFilePreview && !isImageFile && fileContent.trim().length > 0) {
      const ext = currentFile.split('.').pop() || '';
      // Always apply highlighting if we don't have highlighted content or it's empty or doesn't contain hljs
      const needsHighlighting = !highlightedFileContent || 
                                highlightedFileContent.trim() === '' || 
                                !highlightedFileContent.includes('hljs');
      
      if (needsHighlighting) {
        // Use a small delay to avoid race conditions with file loading
        const timeoutId = setTimeout(() => {
          console.log('[FilesTab] Applying syntax highlighting:', { ext, contentLength: fileContent.length, currentFile });
          onApplySyntaxHighlighting(fileContent, ext).catch(err => {
            console.error('[FilesTab] Error applying syntax highlighting:', err);
          });
        }, 50);
        
        return () => clearTimeout(timeoutId);
      }
    }
  });
</script>

<TabLayout 
  {loading} 
  {error}
  activeTab={activeTab}
  tabs={tabs}
  onTabChange={onTabChange}
  title={currentFile ? `File: ${currentFile.split('/').pop()}` : 'Files'}
>
  {#snippet leftPane()}
    {#if isMaintainer && onCreateFile}
      <div class="create-file-header">
        <button 
          onclick={onCreateFile}
          class="create-file-button"
          title="Create New File"
          disabled={needsClone}
        >
          <img src="/icons/plus.svg" alt="New" class="icon" />
          <span>New File</span>
        </button>
      </div>
    {/if}
    <FileBrowser
      {files}
      {currentPath}
      {onFileClick}
      {onDirectoryClick}
      {onNavigateBack}
      {pathStack}
    />
  {/snippet}
  
  {#snippet rightPanel()}
    {#if currentFile}
      <div class="file-editor">
        <div class="editor-header">
          <span class="file-path">{currentFile}</span>
          <div class="editor-actions">
            {#if branches.length > 0 && isMaintainer}
              <select 
                value={currentBranch || ''} 
                class="branch-selector" 
                disabled={saving || needsClone} 
                title="Select branch"
                onchange={(e) => {
                  const target = e.target as HTMLSelectElement;
                  if (target.value) onBranchChange(target.value);
                }}
              >
                {#each branches as branch}
                  {@const branchName = typeof branch === 'string' ? branch : branch.name}
                  <option value={branchName}>{branchName}{#if branchName === defaultBranch} (default){/if}</option>
                {/each}
              </select>
            {:else if currentBranch && isMaintainer}
              <span class="branch-display" title="Current branch">{currentBranch}</span>
            {/if}
            {#if hasChanges}
              <span class="unsaved-indicator">● Unsaved changes</span>
            {/if}
            {#if currentFile && supportsPreview((currentFile.split('.').pop() || '').toLowerCase())}
              <button 
                onclick={onTogglePreview}
                class="preview-toggle-button"
                title={showFilePreview ? 'Show raw' : 'Show preview'}
              >
                {showFilePreview ? 'Raw' : 'Preview'}
              </button>
            {/if}
            {#if currentFile && fileContent}
              <button 
                onclick={onCopyFileContent}
                disabled={copyingFile}
                class="file-action-button"
                title="Copy raw content to clipboard"
              >
                <img src="/icons/copy.svg" alt="Copy" class="icon-inline" />
              </button>
              <button 
                onclick={onDownloadFile}
                class="file-action-button"
                title="Download file"
              >
                <img src="/icons/download.svg" alt="Download" class="icon-inline" />
              </button>
            {/if}
            {#if isMaintainer}
              <button 
                onclick={onSave} 
                disabled={!hasChanges || saving || needsClone} 
                class="save-button"
                title={needsClone ? cloneTooltip : (hasChanges ? 'Save changes' : 'No changes to save')}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            {:else if userPubkey}
              <span class="non-maintainer-notice">Only maintainers can edit files. Submit a PR instead.</span>
            {/if}
          </div>
        </div>
        
        {#if loading}
          <div class="loading">Loading file...</div>
        {:else}
          <div class="editor-container">
            {#if isMaintainer}
              {#if currentFile && showFilePreview && fileHtml && supportsPreview((currentFile.split('.').pop() || '').toLowerCase())}
                <div class="read-only-editor" class:word-wrap={wordWrap}>
                  <div class="file-preview markdown">
                    <NostrHtmlRenderer html={fileHtml} />
                  </div>
                </div>
              {:else}
                <CodeEditor
                  content={editedContent || fileContent}
                  language={fileLanguage}
                  readOnly={needsClone}
                  onChange={(value) => {
                    editedContent = value;
                    hasChanges = value !== fileContent;
                    onContentChange(value);
                  }}
                />
              {/if}
            {:else}
              <div class="read-only-editor" class:word-wrap={wordWrap}>
                {#if isImageFile && imageUrl}
                  <div class="file-preview image-preview">
                    <img src={imageUrl} alt={currentFile?.split('/').pop() || 'Image'} class="file-image" />
                  </div>
                {:else if currentFile && showFilePreview && fileHtml && supportsPreview((currentFile.split('.').pop() || '').toLowerCase())}
                  <div class="file-preview markdown">
                    <NostrHtmlRenderer html={fileHtml} />
                  </div>
                {:else if fileContent}
                  <div class="raw-content">
                    {#if highlightedFileContent && highlightedFileContent.trim() !== ''}
                      {@html highlightedFileContent}
                    {:else}
                      <pre><code class="hljs language-plaintext">{fileContent}</code></pre>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        
        {#if hasChanges && isMaintainer}
          <div class="editor-footer">
            <span class="unsaved-indicator">Unsaved changes</span>
          </div>
        {/if}
      </div>
    {:else if files.length === 0}
      <div class="empty-state">
        <p>This repo is empty and contains no files.</p>
      </div>
    {:else}
      <div class="empty-state">
        <p>Select a file from the left to view it on the right</p>
      </div>
    {/if}
  {/snippet}
</TabLayout>

<style>
  .file-editor {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  
  .file-editor .editor-header {
    display: flex !important;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
    width: 100%;
    min-width: 0;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-primary);
    position: relative;
    z-index: 1;
    visibility: visible !important;
    opacity: 1 !important;
  }
  
  .file-path {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 1rem;
  }
  
  .editor-footer {
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  
  .unsaved-indicator {
    color: var(--accent-warning);
    font-size: 0.9rem;
  }
  
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
  }
  
  .raw-content {
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    box-sizing: border-box;
    contain: layout;
    min-width: 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  
  .raw-content pre {
    margin: 0;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    overflow-x: hidden;
    overflow-y: visible;
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: pre-wrap;
    max-width: 100%;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
  }
  
  .raw-content code {
    display: block;
    overflow-x: hidden;
    overflow-y: visible;
    max-width: 100%;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    word-break: break-word;
    overflow-wrap: break-word;
    white-space: pre-wrap;
  }
  
  .raw-content :global(code.hljs) {
    overflow-x: hidden !important;
    overflow-y: visible !important;
    display: block;
    max-width: 100% !important;
    min-width: 0;
    word-break: break-word !important;
    overflow-wrap: break-word !important;
    white-space: pre-wrap !important;
    box-sizing: border-box;
  }
  
  .raw-content :global(code.hljs *),
  .raw-content :global(code.hljs span),
  .raw-content :global(code.hljs .hljs-tag),
  .raw-content :global(code.hljs .hljs-name),
  .raw-content :global(code.hljs .hljs-attr),
  .raw-content :global(code.hljs .hljs-string),
  .raw-content :global(code.hljs .hljs-section),
  .raw-content :global(code.hljs .hljs-quote),
  .raw-content :global(code.hljs .hljs-link),
  .raw-content :global(code.hljs .hljs-code),
  .raw-content :global(code.hljs .hljs-bullet),
  .raw-content :global(code.hljs .language-xml) {
    max-width: 100% !important;
    word-break: break-word !important;
    overflow-wrap: break-word !important;
    white-space: pre-wrap !important;
    display: inline;
    box-sizing: border-box;
    overflow-x: hidden !important;
  }
  
  .raw-content :global(pre code.hljs) {
    width: 100%;
    max-width: 100% !important;
    min-width: 0;
  }
  
  .editor-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .editor-container :global(.code-editor) {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0;
    box-sizing: border-box;
  }

  .editor-container :global(.code-editor),
  .editor-container :global(.code-editor *) {
    max-width: 100% !important;
    box-sizing: border-box;
  }
  
  .read-only-editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }
  
  .read-only-editor > .raw-content,
  .read-only-editor > .file-preview {
    flex: 1;
    min-height: 0;
    overflow: auto;
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }
  
  .read-only-editor > .raw-content > pre {
    max-width: 100%;
    min-width: 0;
    overflow-x: hidden !important;
    overflow-y: visible !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
    white-space: pre-wrap !important;
  }
  
  .read-only-editor > .raw-content > pre > code {
    max-width: 100%;
    min-width: 0;
    display: block;
    overflow-x: hidden !important;
    overflow-y: visible !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
    white-space: pre-wrap !important;
  }
  
  .file-editor .editor-actions {
    display: flex !important;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    flex-shrink: 0;
    visibility: visible !important;
    opacity: 1 !important;
    width: auto;
    min-width: 0;
  }

  .create-file-header {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 0.5rem;
  }

  .create-file-button {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    transition: background 0.2s;
  }

  .create-file-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .create-file-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .create-file-button .icon {
    width: 16px;
    height: 16px;
    filter: brightness(0) invert(1);
  }
</style>
