<script lang="ts">
  import type { FileEntry } from '$lib/services/git/file-manager.js';
  
  interface Props {
    files?: FileEntry[];
    currentPath?: string;
    loading?: boolean;
    onFileClick?: (file: FileEntry) => void;
    onDirectoryClick?: (path: string) => void;
    onNavigateBack?: () => void;
    pathStack?: string[];
  }
  
  let {
    files = [],
    currentPath = '',
    loading = false,
    onFileClick = () => {},
    onDirectoryClick = () => {},
    onNavigateBack = () => {},
    pathStack = []
  }: Props = $props();
</script>

<div class="file-browser">
  {#if loading}
    <div class="loading">Loading files...</div>
  {:else if files.length === 0}
    <div class="empty">No files found</div>
  {:else}
    <div class="file-list">
      {#if currentPath}
        <button class="nav-back" onclick={onNavigateBack}>
          ← Back
        </button>
      {/if}
      
      {#each files as file}
        <div 
          class="file-item {file.type}"
          role="button"
          tabindex="0"
          onclick={() => file.type === 'directory' ? onDirectoryClick(file.path) : onFileClick(file)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              file.type === 'directory' ? onDirectoryClick(file.path) : onFileClick(file);
            }
          }}
        >
          <span class="icon">
            {#if file.type === 'directory'}
              📁
            {:else}
              📄
            {/if}
          </span>
          <span class="name">{file.name}</span>
          {#if file.size !== undefined}
            <span class="size">{(file.size / 1024).toFixed(1)} KB</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .file-browser {
    padding: 1rem;
  }
  
  .loading, .empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .nav-back {
    padding: 0.5rem 1rem;
    margin-bottom: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
  }
  
  .nav-back:hover {
    background: var(--bg-hover);
  }
  
  .file-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
  }
  
  .file-item:hover {
    background: var(--bg-hover);
  }
  
  .file-item.directory {
    font-weight: 500;
  }
  
  .icon {
    font-size: 1.2rem;
  }
  
  .name {
    flex: 1;
  }
  
  .size {
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
</style>
