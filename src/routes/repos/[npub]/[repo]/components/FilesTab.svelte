<script lang="ts">
  /**
   * Files tab component
   * Handles file browser, editor, and README display
   */
  
  import TabLayout from './TabLayout.svelte';
  import FileBrowser from './FileBrowser.svelte';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  
  export let files: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }> = [];
  export let currentPath: string = '';
  export let currentFile: string | null = null;
  export let fileContent: string = '';
  export let fileLanguage: 'markdown' | 'asciidoc' | 'text' = 'text';
  export let editedContent: string = '';
  export let hasChanges: boolean = false;
  export let loading: boolean = false;
  export let error: string | null = null;
  export let pathStack: string[] = [];
  export let onFileClick: (file: { name: string; path: string; type: 'file' | 'directory' }) => void = () => {};
  export let onDirectoryClick: (path: string) => void = () => {};
  export let onNavigateBack: () => void = () => {};
  export let onContentChange: (content: string) => void = () => {};
  export let isMaintainer: boolean = false;
  export let readmeContent: string | null = null;
  export let readmePath: string | null = null;
  export let readmeHtml: string | null = null;
  export let showFilePreview: boolean = false;
  export let fileHtml: string | null = null;
  export let highlightedFileContent: string | null = null;
  export let isImageFile: boolean = false;
  export let imageUrl: string | null = null;
  export let wordWrap: boolean = false;
  export let supportsPreview: (ext: string) => boolean = () => false;
  export let onSave: () => void = () => {};
  export let onTogglePreview: () => void = () => {};
  export let onCopyFileContent: (e: Event) => void = () => {};
  export let onDownloadFile: () => void = () => {};
  export let copyingFile: boolean = false;
  export let saving: boolean = false;
  export let needsClone: boolean = false;
  export let cloneTooltip: string = '';
  export let branches: Array<string | { name: string }> = [];
  export let currentBranch: string | null = null;
  export let defaultBranch: string | null = null;
  export let onBranchChange: (branch: string) => void = () => {};
  export let userPubkey: string | null = null;
</script>

<TabLayout {loading} {error}>
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
          <div class="readme-content">
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
                  {@html highlightedFileContent}
                {:else}
                  <pre><code class="hljs">{fileContent}</code></pre>
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
</style>
