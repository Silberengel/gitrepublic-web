<script lang="ts">
  /**
   * Files tab component
   * Handles file browser, editor, and README display
   */
  
  import TabLayout from './TabLayout.svelte';
  import FileBrowser from './FileBrowser.svelte';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  
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
    readmeContent?: string | null;
    readmePath?: string | null;
    readmeHtml?: string | null;
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
    readmeContent = null,
    readmePath = null,
    readmeHtml = null,
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
    onTabChange = () => {}
  }: Props = $props();
</script>

<TabLayout 
  {loading} 
  {error}
  activeTab={activeTab}
  tabs={tabs}
  onTabChange={onTabChange}
  title={currentFile ? `File: ${currentFile.split('/').pop()}` : (readmeContent ? 'README' : 'Files')}
>
  {#snippet leftPane()}
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
    {#if readmeContent && !currentFile}
      <div class="readme-section">
        <div class="readme-header">
          <h3>README</h3>
          <div class="readme-actions">
            {#if readmePath && supportsPreview((readmePath.split('.').pop() || '').toLowerCase())}
              <button 
                onclick={onTogglePreview}
                class="preview-toggle-button"
                title={showFilePreview ? 'Show raw' : 'Show preview'}
              >
                {showFilePreview ? 'Raw' : 'Preview'}
              </button>
            {/if}
            {#if readmePath}
              <a href={`/api/repos/${readmePath}`} target="_blank" class="raw-link">View Raw</a>
            {/if}
          </div>
        </div>
        {#if showFilePreview && readmeHtml && readmeHtml.trim()}
          <div class="readme-content markdown">
            {@html readmeHtml}
          </div>
        {:else if readmeContent}
          <div class="readme-content raw-content">
            <pre><code class="hljs language-text">{readmeContent}</code></pre>
          </div>
        {/if}
      </div>
    {:else if currentFile}
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
            {#if currentFile && supportsPreview((currentFile.split('.').pop() || '').toLowerCase()) && !isMaintainer}
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
            {:else}
              <div class="read-only-editor" class:word-wrap={wordWrap}>
                {#if isImageFile && imageUrl}
                  <div class="file-preview image-preview">
                    <img src={imageUrl} alt={currentFile?.split('/').pop() || 'Image'} class="file-image" />
                  </div>
                {:else if currentFile && showFilePreview && fileHtml && supportsPreview((currentFile.split('.').pop() || '').toLowerCase())}
                  <div class="file-preview markdown">
                    {@html fileHtml}
                  </div>
                {:else if highlightedFileContent}
                  <div class="raw-content">
                    {@html highlightedFileContent}
                  </div>
                {:else}
                  <div class="raw-content">
                    <pre><code class="hljs">{fileContent}</code></pre>
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
    {:else if files.length === 0 && !readmeContent}
      <div class="empty-state">
        <p>This repo is empty and contains no files.</p>
      </div>
    {:else}
      <div class="empty-state">
        <p>Select a file to view or edit</p>
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
    overflow-x: auto;
    overflow-y: auto;
    box-sizing: border-box;
    contain: layout;
    min-width: 0;
  }
  
  .raw-content pre {
    margin: 0;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    overflow-x: auto;
    word-wrap: break-word;
    white-space: pre-wrap;
    max-width: 100%;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
  }
  
  .raw-content code {
    display: block;
    overflow-x: auto;
    max-width: 100%;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  
  .raw-content :global(code.hljs) {
    overflow-x: auto;
    display: block;
    max-width: 100% !important;
    min-width: 0;
    word-break: break-word;
    overflow-wrap: break-word;
    white-space: pre-wrap;
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
  }
  
  .raw-content :global(pre code.hljs) {
    width: 100%;
    max-width: 100% !important;
    min-width: 0;
  }
  
  .readme-content.raw-content {
    max-width: 100%;
    overflow-x: auto;
    box-sizing: border-box;
    width: 100%;
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
  }
  
  .read-only-editor > .raw-content > pre > code {
    max-width: 100%;
    min-width: 0;
    display: block;
  }
  
  .readme-section {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  
  .readme-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    width: 100%;
  }
  
  .readme-header h3 {
    margin: 0;
    font-size: 1.25rem;
    color: var(--text-primary);
  }
  
  .readme-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  
  .readme-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    width: 100%;
    max-width: 100%;
    padding: 1.5rem;
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
</style>
