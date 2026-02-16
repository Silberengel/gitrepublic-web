<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import PRDetail from '$lib/components/PRDetail.svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import { nip19 } from 'nostr-tools';

  // Get page data for OpenGraph metadata
  const pageData = $page.data as {
    title?: string;
    description?: string;
    image?: string;
    banner?: string;
    repoName?: string;
    repoDescription?: string;
    repoUrl?: string;
  };

  const npub = ($page.params as { npub?: string; repo?: string }).npub || '';
  const repo = ($page.params as { npub?: string; repo?: string }).repo || '';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let files = $state<Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>>([]);
  let currentPath = $state('');
  let currentFile = $state<string | null>(null);
  let fileContent = $state('');
  let fileLanguage = $state<'markdown' | 'asciidoc' | 'text'>('text');
  let editedContent = $state('');
  let hasChanges = $state(false);
  let saving = $state(false);
  let branches = $state<string[]>([]);
  let currentBranch = $state('main');
  let commitMessage = $state('');
  let userPubkey = $state<string | null>(null);
  let showCommitDialog = $state(false);
  let activeTab = $state<'files' | 'history' | 'tags' | 'issues' | 'prs'>('files');

  // Navigation stack for directories
  let pathStack = $state<string[]>([]);

  // New file creation
  let showCreateFileDialog = $state(false);
  let newFileName = $state('');
  let newFileContent = $state('');

  // Branch creation
  let showCreateBranchDialog = $state(false);
  let newBranchName = $state('');
  let newBranchFrom = $state('main');

  // Commit history
  let commits = $state<Array<{ hash: string; message: string; author: string; date: string; files: string[] }>>([]);
  let loadingCommits = $state(false);
  let selectedCommit = $state<string | null>(null);
  let showDiff = $state(false);
  let diffData = $state<Array<{ file: string; additions: number; deletions: number; diff: string }>>([]);

  // Tags
  let tags = $state<Array<{ name: string; hash: string; message?: string }>>([]);
  let showCreateTagDialog = $state(false);
  let newTagName = $state('');
  let newTagMessage = $state('');
  let newTagRef = $state('HEAD');

  // Maintainer status
  let isMaintainer = $state(false);
  let loadingMaintainerStatus = $state(false);
  
  // Verification status
  let verificationStatus = $state<{ verified: boolean; error?: string; message?: string } | null>(null);
  let loadingVerification = $state(false);

  // Issues
  let issues = $state<Array<{ id: string; subject: string; content: string; status: string; author: string; created_at: number }>>([]);
  let loadingIssues = $state(false);
  let showCreateIssueDialog = $state(false);
  let newIssueSubject = $state('');
  let newIssueContent = $state('');
  let newIssueLabels = $state<string[]>(['']);

  // Pull Requests
  let prs = $state<Array<{ id: string; subject: string; content: string; status: string; author: string; created_at: number; commitId?: string }>>([]);
  let loadingPRs = $state(false);
  let showCreatePRDialog = $state(false);
  let newPRSubject = $state('');
  let newPRContent = $state('');
  let newPRCommitId = $state('');
  let newPRBranchName = $state('');
  let newPRLabels = $state<string[]>(['']);
  let selectedPR = $state<string | null>(null);

  // README
  let readmeContent = $state<string | null>(null);
  let readmePath = $state<string | null>(null);
  let readmeIsMarkdown = $state(false);
  let loadingReadme = $state(false);
  let readmeHtml = $state<string>('');

  // Fork
  let forkInfo = $state<{ isFork: boolean; originalRepo: { npub: string; repo: string } | null } | null>(null);
  let forking = $state(false);

  // Repository images
  let repoImage = $state<string | null>(null);
  let repoBanner = $state<string | null>(null);

  async function loadReadme() {
    loadingReadme = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/readme?ref=${currentBranch}`);
      if (response.ok) {
        const data = await response.json();
        if (data.found) {
          readmeContent = data.content;
          readmePath = data.path;
          readmeIsMarkdown = data.isMarkdown;
          
          // Render markdown if needed
          if (readmeIsMarkdown && readmeContent) {
            const { marked } = await import('marked');
            readmeHtml = marked.parse(readmeContent) as string;
          }
        }
      }
    } catch (err) {
      console.error('Error loading README:', err);
    } finally {
      loadingReadme = false;
    }
  }

  async function loadForkInfo() {
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/fork`);
      if (response.ok) {
        forkInfo = await response.json();
      }
    } catch (err) {
      console.error('Error loading fork info:', err);
    }
  }

  async function forkRepository() {
    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    forking = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPubkey })
      });

      if (response.ok) {
        const data = await response.json();
        alert(`Repository forked successfully! Visit /repos/${data.fork.npub}/${data.fork.repo}`);
        goto(`/repos/${data.fork.npub}/${data.fork.repo}`);
      } else {
        const data = await response.json();
        error = data.error || 'Failed to fork repository';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fork repository';
    } finally {
      forking = false;
    }
  }

  async function loadRepoImages() {
    try {
      // Get images from page data (loaded from announcement)
      if (pageData.image) {
        repoImage = pageData.image;
      }
      if (pageData.banner) {
        repoBanner = pageData.banner;
      }

      // Also fetch from announcement directly as fallback
      if (!repoImage && !repoBanner) {
        const decoded = nip19.decode(npub);
        if (decoded.type === 'npub') {
          const repoOwnerPubkey = decoded.data as string;
          const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
          const events = await client.fetchEvents([
            {
              kinds: [30617], // REPO_ANNOUNCEMENT
              authors: [repoOwnerPubkey],
              '#d': [repo],
              limit: 1
            }
          ]);

          if (events.length > 0) {
            const announcement = events[0];
            const imageTag = announcement.tags.find((t: string[]) => t[0] === 'image');
            const bannerTag = announcement.tags.find((t: string[]) => t[0] === 'banner');
            
            if (imageTag?.[1]) {
              repoImage = imageTag[1];
            }
            if (bannerTag?.[1]) {
              repoBanner = bannerTag[1];
            }
          }
        }
      }
    } catch (err) {
      console.error('Error loading repo images:', err);
    }
  }

  onMount(async () => {
    await loadBranches();
    await loadFiles();
    await checkAuth();
    await loadTags();
    await checkMaintainerStatus();
    await checkVerification();
    await loadReadme();
    await loadForkInfo();
    await loadRepoImages();
  });

  async function checkAuth() {
    try {
      if (isNIP07Available()) {
        userPubkey = await getPublicKeyWithNIP07();
        // Recheck maintainer status after auth
        await checkMaintainerStatus();
      }
    } catch (err) {
      console.log('NIP-07 not available or user not connected');
      userPubkey = null;
    }
  }

  async function login() {
    try {
      if (!isNIP07Available()) {
        alert('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.');
        return;
      }
      userPubkey = await getPublicKeyWithNIP07();
      // Re-check maintainer status after login
      await checkMaintainerStatus();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to connect';
      console.error('Login error:', err);
    }
  }

  function logout() {
    userPubkey = null;
    isMaintainer = false;
  }

  async function checkMaintainerStatus() {
    if (!userPubkey) {
      isMaintainer = false;
      return;
    }

    loadingMaintainerStatus = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/maintainers?userPubkey=${encodeURIComponent(userPubkey)}`);
      if (response.ok) {
        const data = await response.json();
        isMaintainer = data.isMaintainer || false;
      }
    } catch (err) {
      console.error('Failed to check maintainer status:', err);
      isMaintainer = false;
    } finally {
      loadingMaintainerStatus = false;
    }
  }

  async function checkVerification() {
    loadingVerification = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/verify`);
      if (response.ok) {
        const data = await response.json();
        verificationStatus = data;
      }
    } catch (err) {
      console.error('Failed to check verification:', err);
      verificationStatus = { verified: false, error: 'Failed to check verification' };
    } finally {
      loadingVerification = false;
    }
  }

  async function loadBranches() {
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`);
      if (response.ok) {
        branches = await response.json();
        if (branches.length > 0 && !branches.includes(currentBranch)) {
          currentBranch = branches[0];
        }
      }
    } catch (err) {
      console.error('Failed to load branches:', err);
    }
  }

  async function loadFiles(path: string = '') {
    loading = true;
    error = null;
    try {
      const url = `/api/repos/${npub}/${repo}/tree?ref=${currentBranch}&path=${encodeURIComponent(path)}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to load files: ${response.statusText}`);
      }

      files = await response.json();
      currentPath = path;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Error loading files:', err);
    } finally {
      loading = false;
    }
  }

  async function loadFile(filePath: string) {
    loading = true;
    error = null;
    try {
      const url = `/api/repos/${npub}/${repo}/file?path=${encodeURIComponent(filePath)}&ref=${currentBranch}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to load file: ${response.statusText}`);
      }

      const data = await response.json();
      fileContent = data.content;
      editedContent = data.content;
      currentFile = filePath;
      hasChanges = false;

      // Determine language from file extension
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext === 'md' || ext === 'markdown') {
        fileLanguage = 'markdown';
      } else if (ext === 'adoc' || ext === 'asciidoc') {
        fileLanguage = 'asciidoc';
      } else {
        fileLanguage = 'text';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load file';
      console.error('Error loading file:', err);
    } finally {
      loading = false;
    }
  }

  function handleContentChange(value: string) {
    editedContent = value;
    hasChanges = value !== fileContent;
  }

  function handleFileClick(file: { name: string; path: string; type: 'file' | 'directory' }) {
    if (file.type === 'directory') {
      pathStack.push(currentPath);
      loadFiles(file.path);
    } else {
      loadFile(file.path);
    }
  }

  function handleBack() {
    if (pathStack.length > 0) {
      const parentPath = pathStack.pop() || '';
      loadFiles(parentPath);
    } else {
      loadFiles('');
    }
  }

  async function saveFile() {
    if (!currentFile || !commitMessage.trim()) {
      alert('Please enter a commit message');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension to save files');
      return;
    }

    saving = true;
    error = null;

    try {
      // Get npub from pubkey
      const npubFromPubkey = nip19.npubEncode(userPubkey);
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: currentFile,
          content: editedContent,
          commitMessage: commitMessage.trim(),
          authorName: 'Web Editor',
          authorEmail: `${npubFromPubkey}@nostr`,
          branch: currentBranch,
          userPubkey: userPubkey,
          useNIP07: true // Use NIP-07 for commit signing in web UI
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save file');
      }

      // Reload file to get updated content
      await loadFile(currentFile);
      commitMessage = '';
      showCommitDialog = false;
      alert('File saved successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Error saving file:', err);
    } finally {
      saving = false;
    }
  }

  function handleBranchChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    currentBranch = target.value;
    if (currentFile) {
      loadFile(currentFile);
    } else {
      loadFiles(currentPath);
    }
  }

  async function createFile() {
    if (!newFileName.trim()) {
      alert('Please enter a file name');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const npubFromPubkey = nip19.npubEncode(userPubkey);
      const filePath = currentPath ? `${currentPath}/${newFileName}` : newFileName;
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content: newFileContent,
          commitMessage: `Create ${newFileName}`,
          authorName: 'Web Editor',
          authorEmail: `${npubFromPubkey}@nostr`,
          branch: currentBranch,
          action: 'create',
          userPubkey: userPubkey
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create file');
      }

      showCreateFileDialog = false;
      newFileName = '';
      newFileContent = '';
      await loadFiles(currentPath);
      alert('File created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create file';
    } finally {
      saving = false;
    }
  }

  async function deleteFile(filePath: string) {
    if (!confirm(`Are you sure you want to delete ${filePath}?`)) {
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const npubFromPubkey = nip19.npubEncode(userPubkey);
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          commitMessage: `Delete ${filePath}`,
          authorName: 'Web Editor',
          authorEmail: `${npubFromPubkey}@nostr`,
          branch: currentBranch,
          action: 'delete',
          userPubkey: userPubkey
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete file');
      }

      if (currentFile === filePath) {
        currentFile = null;
      }
      await loadFiles(currentPath);
      alert('File deleted successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to delete file';
    } finally {
      saving = false;
    }
  }

  async function createBranch() {
    if (!newBranchName.trim()) {
      alert('Please enter a branch name');
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: newBranchName,
          fromBranch: newBranchFrom
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create branch');
      }

      showCreateBranchDialog = false;
      newBranchName = '';
      await loadBranches();
      alert('Branch created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create branch';
    } finally {
      saving = false;
    }
  }

  async function loadCommitHistory() {
    loadingCommits = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/commits?branch=${currentBranch}&limit=50`);
      if (response.ok) {
        commits = await response.json();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load commit history';
    } finally {
      loadingCommits = false;
    }
  }

  async function viewDiff(commitHash: string) {
    loadingCommits = true;
    error = null;
    try {
      const parentHash = commits.find(c => c.hash === commitHash) 
        ? commits[commits.findIndex(c => c.hash === commitHash) + 1]?.hash || `${commitHash}^`
        : `${commitHash}^`;
      
      const response = await fetch(`/api/repos/${npub}/${repo}/diff?from=${parentHash}&to=${commitHash}`);
      if (response.ok) {
        diffData = await response.json();
        selectedCommit = commitHash;
        showDiff = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load diff';
    } finally {
      loadingCommits = false;
    }
  }

  async function loadTags() {
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/tags`);
      if (response.ok) {
        tags = await response.json();
      }
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }

  async function createTag() {
    if (!newTagName.trim()) {
      alert('Please enter a tag name');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tagName: newTagName,
          ref: newTagRef,
          message: newTagMessage || undefined,
          userPubkey: userPubkey
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create tag');
      }

      showCreateTagDialog = false;
      newTagName = '';
      newTagMessage = '';
      await loadTags();
      alert('Tag created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create tag';
    } finally {
      saving = false;
    }
  }

  async function loadIssues() {
    loadingIssues = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/issues`);
      if (response.ok) {
        const data = await response.json();
        issues = data.map((issue: any) => ({
          id: issue.id,
          subject: issue.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
          content: issue.content,
          status: issue.status || 'open',
          author: issue.pubkey,
          created_at: issue.created_at
        }));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load issues';
    } finally {
      loadingIssues = false;
    }
  }

  async function createIssue() {
    if (!newIssueSubject.trim() || !newIssueContent.trim()) {
      alert('Please enter a subject and content');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const { IssuesService } = await import('$lib/services/nostr/issues-service.js');
      
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(userPubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const issuesService = new IssuesService(combinedRelays);
      const issue = await issuesService.createIssue(
        repoOwnerPubkey,
        repo,
        newIssueSubject.trim(),
        newIssueContent.trim(),
        newIssueLabels.filter(l => l.trim())
      );

      showCreateIssueDialog = false;
      newIssueSubject = '';
      newIssueContent = '';
      newIssueLabels = [''];
      await loadIssues();
      alert('Issue created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create issue';
      console.error('Error creating issue:', err);
    } finally {
      saving = false;
    }
  }

  async function loadPRs() {
    loadingPRs = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/prs`);
      if (response.ok) {
        const data = await response.json();
        prs = data.map((pr: any) => ({
          id: pr.id,
          subject: pr.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
          content: pr.content,
          status: pr.status || 'open',
          author: pr.pubkey,
          created_at: pr.created_at,
          commitId: pr.tags.find((t: string[]) => t[0] === 'c')?.[1]
        }));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      loadingPRs = false;
    }
  }

  async function createPR() {
    if (!newPRSubject.trim() || !newPRContent.trim() || !newPRCommitId.trim()) {
      alert('Please enter a subject, content, and commit ID');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const { PRsService } = await import('$lib/services/nostr/prs-service.js');
      const { getGitUrl } = await import('$lib/config.js');
      
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(userPubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const cloneUrl = getGitUrl(npub, repo);
      const prsService = new PRsService(combinedRelays);
      const pr = await prsService.createPullRequest(
        repoOwnerPubkey,
        repo,
        newPRSubject.trim(),
        newPRContent.trim(),
        newPRCommitId.trim(),
        cloneUrl,
        newPRBranchName.trim() || undefined,
        newPRLabels.filter(l => l.trim())
      );

      showCreatePRDialog = false;
      newPRSubject = '';
      newPRContent = '';
      newPRCommitId = '';
      newPRBranchName = '';
      newPRLabels = [''];
      await loadPRs();
      alert('Pull request created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create pull request';
      console.error('Error creating PR:', err);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    if (activeTab === 'history') {
      loadCommitHistory();
    } else if (activeTab === 'tags') {
      loadTags();
    } else if (activeTab === 'issues') {
      loadIssues();
    } else if (activeTab === 'prs') {
      loadPRs();
    }
  });

  $effect(() => {
    if (currentBranch) {
      loadReadme();
    }
  });
</script>

<svelte:head>
  <title>{pageData.title || `${repo} - Repository`}</title>
  <meta name="description" content={pageData.description || `Repository: ${repo}`} />
  
  <!-- OpenGraph / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:title" content={pageData.title || `${pageData.repoName || repo} - Repository`} />
  <meta property="og:description" content={pageData.description || pageData.repoDescription || `Repository: ${pageData.repoName || repo}`} />
  <meta property="og:url" content={pageData.repoUrl || `https://${$page.url.host}${$page.url.pathname}`} />
  {#if pageData.image || repoImage}
    <meta property="og:image" content={pageData.image || repoImage} />
  {/if}
  {#if pageData.banner || repoBanner}
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
  {/if}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content={repoBanner || repoImage ? "summary_large_image" : "summary"} />
  <meta name="twitter:title" content={pageData.title || `${pageData.repoName || repo} - Repository`} />
  <meta name="twitter:description" content={pageData.description || pageData.repoDescription || `Repository: ${pageData.repoName || repo}`} />
  {#if pageData.banner || repoBanner}
    <meta name="twitter:image" content={pageData.banner || repoBanner} />
  {:else if pageData.image || repoImage}
    <meta name="twitter:image" content={pageData.image || repoImage} />
  {/if}
</svelte:head>

<div class="container">
  <header>
    {#if repoBanner}
      <div class="repo-banner">
        <img src={repoBanner} alt="" />
      </div>
    {/if}
    <div class="header-left">
      <a href="/" class="back-link">← Back to Repositories</a>
      <div class="repo-title-section">
        {#if repoImage}
          <img src={repoImage} alt="Repository image" class="repo-image" />
        {/if}
        <div>
          <h1>{pageData.repoName || repo}</h1>
          {#if pageData.repoDescription}
            <p class="repo-description-header">{pageData.repoDescription}</p>
          {/if}
        </div>
      </div>
      <span class="npub">
        by <a href={`/users/${npub}`}>{npub.slice(0, 16)}...</a>
      </span>
      <a href="/docs/nip34" class="docs-link" target="_blank" title="NIP-34 Documentation">📖</a>
      {#if forkInfo?.isFork && forkInfo.originalRepo}
        <span class="fork-badge">Forked from <a href={`/repos/${forkInfo.originalRepo.npub}/${forkInfo.originalRepo.repo}`}>{forkInfo.originalRepo.repo}</a></span>
      {/if}
    </div>
      <div class="header-right">
      <select bind:value={currentBranch} onchange={handleBranchChange} class="branch-select">
        {#each branches as branch}
          <option value={branch}>{branch}</option>
        {/each}
      </select>
      {#if userPubkey}
        <button onclick={forkRepository} disabled={forking} class="fork-button">
          {forking ? 'Forking...' : 'Fork'}
        </button>
        {#if isMaintainer}
          <a href={`/repos/${npub}/${repo}/settings`} class="settings-button">Settings</a>
        {/if}
        {#if isMaintainer}
          <button onclick={() => showCreateBranchDialog = true} class="create-branch-button">+ New Branch</button>
        {/if}
        <span class="auth-status">
          {#if isMaintainer}
            ✓ Maintainer
          {:else}
            ✓ Authenticated (Contributor)
          {/if}
        </span>
        <button onclick={logout} class="logout-button">Logout</button>
      {:else}
        <span class="auth-status">Not authenticated</span>
        <button onclick={login} class="login-button" disabled={!isNIP07Available()}>
          {isNIP07Available() ? 'Login' : 'NIP-07 Not Available'}
        </button>
      {/if}
      
      {#if verificationStatus}
        <span class="verification-status" class:verified={verificationStatus.verified} class:unverified={!verificationStatus.verified}>
          {#if verificationStatus.verified}
            ✓ Verified
          {:else}
            ⚠ Unverified
          {/if}
        </span>
      {/if}
    </div>
  </header>

  <main class="repo-view">
    {#if error}
      <div class="error">
        Error: {error}
      </div>
    {/if}

    <!-- Tabs -->
    <div class="tabs">
      <button 
        class="tab-button" 
        class:active={activeTab === 'files'}
        onclick={() => activeTab = 'files'}
      >
        Files
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'history'}
        onclick={() => activeTab = 'history'}
      >
        History
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'tags'}
        onclick={() => activeTab = 'tags'}
      >
        Tags
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'issues'}
        onclick={() => activeTab = 'issues'}
      >
        Issues
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'prs'}
        onclick={() => activeTab = 'prs'}
      >
        Pull Requests
      </button>
    </div>

    <div class="repo-layout">
      <!-- File Tree Sidebar -->
      {#if activeTab === 'files'}
      <aside class="file-tree">
        <div class="file-tree-header">
          <h2>Files</h2>
          <div class="file-tree-actions">
            {#if pathStack.length > 0 || currentPath}
              <button onclick={handleBack} class="back-button">← Back</button>
            {/if}
            {#if userPubkey && isMaintainer}
              <button onclick={() => showCreateFileDialog = true} class="create-file-button">+ New File</button>
            {/if}
          </div>
        </div>
        {#if loading && !currentFile}
          <div class="loading">Loading files...</div>
        {:else}
          <ul class="file-list">
            {#each files as file}
              <li class="file-item" class:directory={file.type === 'directory'} class:selected={currentFile === file.path}>
                <button onclick={() => handleFileClick(file)} class="file-button">
                  {#if file.type === 'directory'}
                    📁
                  {:else}
                    📄
                  {/if}
                  {file.name}
                  {#if file.size !== undefined}
                    <span class="file-size">({(file.size / 1024).toFixed(1)} KB)</span>
                  {/if}
                </button>
                {#if userPubkey && isMaintainer && file.type === 'file'}
                  <button onclick={() => deleteFile(file.path)} class="delete-file-button" title="Delete file">🗑️</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Commit History View -->
      {#if activeTab === 'history'}
      <aside class="history-sidebar">
        <div class="history-header">
          <h2>Commit History</h2>
          <button onclick={loadCommitHistory} class="refresh-button">Refresh</button>
        </div>
        {#if loadingCommits}
          <div class="loading">Loading commits...</div>
        {:else if commits.length === 0}
          <div class="empty">No commits found</div>
        {:else}
          <ul class="commit-list">
            {#each commits as commit}
              <li class="commit-item" class:selected={selectedCommit === commit.hash}>
                <button onclick={() => viewDiff(commit.hash)} class="commit-button">
                  <div class="commit-hash">{commit.hash.slice(0, 7)}</div>
                  <div class="commit-message">{commit.message}</div>
                  <div class="commit-meta">
                    <span>{commit.author}</span>
                    <span>{new Date(commit.date).toLocaleString()}</span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Tags View -->
      {#if activeTab === 'tags'}
      <aside class="tags-sidebar">
        <div class="tags-header">
          <h2>Tags</h2>
          {#if userPubkey && isMaintainer}
            <button onclick={() => showCreateTagDialog = true} class="create-tag-button">+ New Tag</button>
          {/if}
        </div>
        {#if tags.length === 0}
          <div class="empty">No tags found</div>
        {:else}
          <ul class="tag-list">
            {#each tags as tag}
              <li class="tag-item">
                <div class="tag-name">{tag.name}</div>
                <div class="tag-hash">{tag.hash.slice(0, 7)}</div>
                {#if tag.message}
                  <div class="tag-message">{tag.message}</div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Issues View -->
      {#if activeTab === 'issues'}
      <aside class="issues-sidebar">
        <div class="issues-header">
          <h2>Issues</h2>
          {#if userPubkey}
            <button onclick={() => showCreateIssueDialog = true} class="create-issue-button">+ New Issue</button>
          {/if}
        </div>
        {#if loadingIssues}
          <div class="loading">Loading issues...</div>
        {:else if issues.length === 0}
          <div class="empty">No issues found</div>
        {:else}
          <ul class="issue-list">
            {#each issues as issue}
              <li class="issue-item">
                <div class="issue-header">
                  <span class="issue-status" class:open={issue.status === 'open'} class:closed={issue.status === 'closed'} class:resolved={issue.status === 'resolved'}>
                    {issue.status}
                  </span>
                  <span class="issue-subject">{issue.subject}</span>
                </div>
                <div class="issue-meta">
                  <span>#{issue.id.slice(0, 7)}</span>
                  <span>{new Date(issue.created_at * 1000).toLocaleDateString()}</span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Pull Requests View -->
      {#if activeTab === 'prs'}
      <aside class="prs-sidebar">
        <div class="prs-header">
          <h2>Pull Requests</h2>
          {#if userPubkey}
            <button onclick={() => showCreatePRDialog = true} class="create-pr-button">+ New PR</button>
          {/if}
        </div>
        {#if loadingPRs}
          <div class="loading">Loading pull requests...</div>
        {:else if prs.length === 0}
          <div class="empty">No pull requests found</div>
        {:else}
          <ul class="pr-list">
            {#each prs as pr}
              <li class="pr-item">
                <div class="pr-header">
                  <span class="pr-status" class:open={pr.status === 'open'} class:closed={pr.status === 'closed'} class:merged={pr.status === 'merged'}>
                    {pr.status}
                  </span>
                  <span class="pr-subject">{pr.subject}</span>
                </div>
                <div class="pr-meta">
                  <span>#{pr.id.slice(0, 7)}</span>
                  {#if pr.commitId}
                    <span class="pr-commit">Commit: {pr.commitId.slice(0, 7)}</span>
                  {/if}
                  <span>{new Date(pr.created_at * 1000).toLocaleDateString()}</span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Editor Area / Diff View / README -->
      <div class="editor-area">
        {#if activeTab === 'files' && readmeContent && !currentFile}
          <div class="readme-section">
            <div class="readme-header">
              <h3>README</h3>
              <div class="readme-actions">
                <a href={`/api/repos/${npub}/${repo}/raw?path=${readmePath}`} target="_blank" class="raw-link">View Raw</a>
                <a href={`/api/repos/${npub}/${repo}/download?format=zip`} class="download-link">Download ZIP</a>
              </div>
            </div>
            {#if loadingReadme}
              <div class="loading">Loading README...</div>
            {:else if readmeIsMarkdown && readmeHtml}
              <div class="readme-content markdown">
                {@html readmeHtml}
              </div>
            {:else if readmeContent}
              <pre class="readme-content"><code>{readmeContent}</code></pre>
            {/if}
          </div>
        {/if}

        {#if activeTab === 'files' && currentFile}
          <div class="editor-header">
            <span class="file-path">{currentFile}</span>
            <div class="editor-actions">
              {#if hasChanges}
                <span class="unsaved-indicator">● Unsaved changes</span>
              {/if}
              {#if isMaintainer}
                <button onclick={() => showCommitDialog = true} disabled={!hasChanges || saving} class="save-button">
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
                  content={editedContent} 
                  language={fileLanguage}
                  onChange={handleContentChange}
                />
              {:else}
                <div class="read-only-editor">
                  <pre><code>{editedContent}</code></pre>
                </div>
              {/if}
            </div>
          {/if}
        {:else if activeTab === 'files'}
          <div class="empty-state">
            <p>Select a file from the sidebar to view and edit it</p>
          </div>
        {/if}

        {#if activeTab === 'history' && showDiff}
          <div class="diff-view">
            <div class="diff-header">
              <h3>Diff for commit {selectedCommit?.slice(0, 7)}</h3>
              <button onclick={() => { showDiff = false; selectedCommit = null; }} class="close-button">×</button>
            </div>
            {#each diffData as diff}
              <div class="diff-file">
                <div class="diff-file-header">
                  <span class="diff-file-name">{diff.file}</span>
                  <span class="diff-stats">
                    <span class="additions">+{diff.additions}</span>
                    <span class="deletions">-{diff.deletions}</span>
                  </span>
                </div>
                <pre class="diff-content"><code>{diff.diff}</code></pre>
              </div>
            {/each}
          </div>
        {:else if activeTab === 'history'}
          <div class="empty-state">
            <p>Select a commit to view its diff</p>
          </div>
        {/if}

        {#if activeTab === 'tags'}
          <div class="empty-state">
            <p>Tags are displayed in the sidebar</p>
          </div>
        {/if}

        {#if activeTab === 'issues'}
          <div class="issues-content">
            {#if issues.length === 0}
              <div class="empty-state">
                <p>No issues found. Create one to get started!</p>
              </div>
            {:else}
              {#each issues as issue}
                <div class="issue-detail">
                  <h3>{issue.subject}</h3>
                  <div class="issue-meta-detail">
                    <span class="issue-status" class:open={issue.status === 'open'} class:closed={issue.status === 'closed'} class:resolved={issue.status === 'resolved'}>
                      {issue.status}
                    </span>
                    <span>Created {new Date(issue.created_at * 1000).toLocaleString()}</span>
                  </div>
                  <div class="issue-body">
                    {@html issue.content.replace(/\n/g, '<br>')}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        {#if activeTab === 'prs'}
          <div class="prs-content">
            {#if prs.length === 0}
              <div class="empty-state">
                <p>No pull requests found. Create one to get started!</p>
              </div>
            {:else if selectedPR}
              {#each prs.filter(p => p.id === selectedPR) as pr}
                {@const decoded = nip19.decode(npub)}
                {#if decoded.type === 'npub'}
                  {@const repoOwnerPubkey = decoded.data as string}
                  <PRDetail
                    {pr}
                    {npub}
                    {repo}
                    {repoOwnerPubkey}
                  />
                  <button onclick={() => selectedPR = null} class="back-btn">← Back to PR List</button>
                {/if}
              {/each}
            {:else}
              {#each prs as pr}
                <div class="pr-detail" onclick={() => selectedPR = pr.id} style="cursor: pointer;">
                  <h3>{pr.subject}</h3>
                  <div class="pr-meta-detail">
                    <span class="pr-status" class:open={pr.status === 'open'} class:closed={pr.status === 'closed'} class:merged={pr.status === 'merged'}>
                      {pr.status}
                    </span>
                    {#if pr.commitId}
                      <span>Commit: {pr.commitId.slice(0, 7)}</span>
                    {/if}
                    <span>Created {new Date(pr.created_at * 1000).toLocaleString()}</span>
                  </div>
                  <div class="pr-body">
                    {@html pr.content.replace(/\n/g, '<br>')}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </main>

  <!-- Create File Dialog -->
  {#if showCreateFileDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new file"
      onclick={() => showCreateFileDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateFileDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New File</h3>
        <label>
          File Name:
          <input type="text" bind:value={newFileName} placeholder="filename.md" />
        </label>
        <label>
          Content:
          <textarea bind:value={newFileContent} rows="10" placeholder="File content..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateFileDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createFile} disabled={!newFileName.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Branch Dialog -->
  {#if showCreateBranchDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new branch"
      onclick={() => showCreateBranchDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateBranchDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Branch</h3>
        <label>
          Branch Name:
          <input type="text" bind:value={newBranchName} placeholder="feature/new-feature" />
        </label>
        <label>
          From Branch:
          <select bind:value={newBranchFrom}>
            {#each branches as branch}
              <option value={branch}>{branch}</option>
            {/each}
          </select>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateBranchDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createBranch} disabled={!newBranchName.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create Branch'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Tag Dialog -->
  {#if showCreateTagDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new tag"
      onclick={() => showCreateTagDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateTagDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Tag</h3>
        <label>
          Tag Name:
          <input type="text" bind:value={newTagName} placeholder="v1.0.0" />
        </label>
        <label>
          Reference (commit/branch):
          <input type="text" bind:value={newTagRef} placeholder="HEAD" />
        </label>
        <label>
          Message (optional, for annotated tag):
          <textarea bind:value={newTagMessage} rows="3" placeholder="Tag message..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateTagDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createTag} disabled={!newTagName.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create Tag'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Issue Dialog -->
  {#if showCreateIssueDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new issue"
      onclick={() => showCreateIssueDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateIssueDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Issue</h3>
        <label>
          Subject:
          <input type="text" bind:value={newIssueSubject} placeholder="Issue title..." />
        </label>
        <label>
          Description:
          <textarea bind:value={newIssueContent} rows="10" placeholder="Describe the issue..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateIssueDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createIssue} disabled={!newIssueSubject.trim() || !newIssueContent.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create PR Dialog -->
  {#if showCreatePRDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new pull request"
      onclick={() => showCreatePRDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreatePRDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Pull Request</h3>
        <label>
          Subject:
          <input type="text" bind:value={newPRSubject} placeholder="PR title..." />
        </label>
        <label>
          Description:
          <textarea bind:value={newPRContent} rows="8" placeholder="Describe your changes..."></textarea>
        </label>
        <label>
          Commit ID:
          <input type="text" bind:value={newPRCommitId} placeholder="Commit hash..." />
        </label>
        <label>
          Branch Name (optional):
          <input type="text" bind:value={newPRBranchName} placeholder="feature/new-feature" />
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreatePRDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createPR} disabled={!newPRSubject.trim() || !newPRContent.trim() || !newPRCommitId.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create PR'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Commit Dialog -->
  {#if showCommitDialog}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Commit changes"
      onclick={() => showCommitDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCommitDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Commit Changes</h3>
        <label>
          Commit Message:
          <textarea 
            bind:value={commitMessage} 
            placeholder="Describe your changes..."
            rows="4"
          ></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCommitDialog = false} class="cancel-button">Cancel</button>
          <button onclick={saveFile} disabled={!commitMessage.trim() || saving} class="save-button">
            {saving ? 'Saving...' : 'Commit & Save'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .container {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 2rem;
    border-bottom: 1px solid #e5e7eb;
    background: white;
  }

  .repo-banner {
    width: 100%;
    height: 300px;
    overflow: hidden;
    background: #f3f4f6;
    margin-bottom: 1rem;
  }

  .repo-banner img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .header-left {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .repo-title-section {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .repo-image {
    width: 64px;
    height: 64px;
    border-radius: 8px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .repo-description-header {
    margin: 0.25rem 0 0 0;
    color: #666;
    font-size: 0.9rem;
  }

  .fork-badge {
    padding: 0.25rem 0.5rem;
    background: #e0e7ff;
    color: #3730a3;
    border-radius: 4px;
    font-size: 0.85rem;
    margin-left: 0.5rem;
  }

  .fork-badge a {
    color: #3730a3;
    text-decoration: none;
  }

  .fork-badge a:hover {
    text-decoration: underline;
  }

  .back-link {
    color: #3b82f6;
    text-decoration: none;
    font-size: 0.875rem;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  header h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .npub {
    color: #6b7280;
    font-size: 0.875rem;
  }

  .docs-link {
    color: #3b82f6;
    text-decoration: none;
    font-size: 1.25rem;
    margin-left: 0.5rem;
  }

  .docs-link:hover {
    opacity: 0.7;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .branch-select {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    background: white;
  }

  .auth-status {
    font-size: 0.875rem;
    color: #6b7280;
  }

  .login-button,
  .logout-button {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    background: white;
    color: #374151;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .login-button:hover:not(:disabled) {
    background: #f9fafb;
  }

  .login-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .logout-button {
    background: #ef4444;
    color: white;
    border-color: #ef4444;
    margin-left: 0.5rem;
  }

  .logout-button:hover {
    background: #dc2626;
  }

  .repo-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .repo-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .file-tree {
    width: 300px;
    border-right: 1px solid #e5e7eb;
    background: #f9fafb;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .file-tree-header {
    padding: 1rem;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .file-tree-header h2 {
    margin: 0;
    font-size: 1rem;
  }

  .back-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .back-button:hover {
    background: #e5e7eb;
  }

  .file-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }

  .file-item {
    margin: 0;
  }

  .file-button {
    width: 100%;
    padding: 0.5rem 1rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }

  .file-button:hover {
    background: #f3f4f6;
  }

  .file-item.selected .file-button {
    background: #dbeafe;
    color: #1e40af;
  }

  .file-size {
    color: #6b7280;
    font-size: 0.75rem;
    margin-left: auto;
  }

  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: white;
  }

  .editor-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .file-path {
    font-family: monospace;
    font-size: 0.875rem;
    color: #374151;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .unsaved-indicator {
    color: #f59e0b;
    font-size: 0.875rem;
  }

  .save-button {
    padding: 0.5rem 1rem;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .save-button:hover:not(:disabled) {
    background: #2563eb;
  }

  .save-button:disabled {
    background: #9ca3af;
    cursor: not-allowed;
  }

  .editor-container {
    flex: 1;
    overflow: hidden;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6b7280;
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: #6b7280;
  }

  .error {
    background: #fee2e2;
    color: #991b1b;
    padding: 1rem;
    margin: 1rem;
    border-radius: 0.5rem;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: white;
    padding: 2rem;
    border-radius: 0.5rem;
    min-width: 400px;
    max-width: 600px;
  }

  .modal h3 {
    margin: 0 0 1rem 0;
  }

  .modal label {
    display: block;
    margin-bottom: 1rem;
  }

  .modal textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    font-family: inherit;
    margin-top: 0.5rem;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .cancel-button:hover {
    background: #e5e7eb;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 2rem;
    border-bottom: 1px solid #e5e7eb;
    background: white;
  }

  .tab-button {
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.875rem;
    color: #6b7280;
  }

  .tab-button:hover {
    color: #374151;
  }

  .tab-button.active {
    color: #3b82f6;
    border-bottom-color: #3b82f6;
  }

  /* File tree actions */
  .file-tree-actions {
    display: flex;
    gap: 0.5rem;
  }

  .create-file-button, .create-branch-button, .create-tag-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .create-file-button:hover, .create-branch-button:hover, .create-tag-button:hover {
    background: #2563eb;
  }

  .delete-file-button {
    padding: 0.25rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    opacity: 0.6;
  }

  .delete-file-button:hover {
    opacity: 1;
  }

  .file-item {
    display: flex;
    align-items: center;
  }

  .file-item .file-button {
    flex: 1;
  }

  /* History sidebar */
  .history-sidebar, .tags-sidebar {
    width: 300px;
    border-right: 1px solid #e5e7eb;
    background: #f9fafb;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .history-header, .tags-header {
    padding: 1rem;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .history-header h2, .tags-header h2 {
    margin: 0;
    font-size: 1rem;
  }

  .refresh-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .refresh-button:hover {
    background: #e5e7eb;
  }

  .commit-list, .tag-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }

  .commit-item, .tag-item {
    border-bottom: 1px solid #e5e7eb;
  }

  .commit-button {
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    display: block;
  }

  .commit-button:hover {
    background: #f3f4f6;
  }

  .commit-item.selected .commit-button {
    background: #dbeafe;
  }

  .commit-hash {
    font-family: monospace;
    font-size: 0.75rem;
    color: #6b7280;
    margin-bottom: 0.25rem;
  }

  .commit-message {
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: #374151;
  }

  .commit-meta {
    font-size: 0.75rem;
    color: #6b7280;
    display: flex;
    gap: 1rem;
  }

  .tag-item {
    padding: 0.75rem 1rem;
  }

  .tag-name {
    font-weight: 500;
    color: #3b82f6;
    margin-bottom: 0.25rem;
  }

  .tag-hash {
    font-family: monospace;
    font-size: 0.75rem;
    color: #6b7280;
    margin-bottom: 0.25rem;
  }

  .tag-message {
    font-size: 0.875rem;
    color: #6b7280;
  }

  /* Diff view */
  .diff-view {
    flex: 1;
    overflow: auto;
    padding: 1rem;
  }

  .diff-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .diff-header h3 {
    margin: 0;
  }

  .close-button {
    padding: 0.25rem 0.5rem;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 1.25rem;
    line-height: 1;
  }

  .close-button:hover {
    background: #e5e7eb;
  }

  .diff-file {
    margin-bottom: 2rem;
  }

  .diff-file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background: #f3f4f6;
    border-radius: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .diff-file-name {
    font-family: monospace;
    font-weight: 500;
  }

  .diff-stats {
    display: flex;
    gap: 0.5rem;
  }

  .additions {
    color: #10b981;
  }

  .deletions {
    color: #ef4444;
  }

  .diff-content {
    background: #1f2937;
    color: #f9fafb;
    padding: 1rem;
    border-radius: 0.25rem;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .diff-content code {
    font-family: 'Courier New', monospace;
    white-space: pre;
  }

  /* Issues and PRs */
  .issues-sidebar, .prs-sidebar {
    width: 300px;
    border-right: 1px solid #e5e7eb;
    background: #f9fafb;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .issues-header, .prs-header {
    padding: 1rem;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .issues-header h2, .prs-header h2 {
    margin: 0;
    font-size: 1rem;
  }

  .create-issue-button, .create-pr-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .create-issue-button:hover, .create-pr-button:hover {
    background: #2563eb;
  }

  .issue-list, .pr-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }

  .issue-item, .pr-item {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #e5e7eb;
    cursor: pointer;
  }

  .issue-item:hover, .pr-item:hover {
    background: #f3f4f6;
  }

  .issue-header, .pr-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .issue-status, .pr-status {
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
  }

  .issue-status.open, .pr-status.open {
    background: #dbeafe;
    color: #1e40af;
  }

  .issue-status.closed, .pr-status.closed {
    background: #fee2e2;
    color: #991b1b;
  }

  .issue-status.resolved, .pr-status.merged {
    background: #d1fae5;
    color: #065f46;
  }

  .issue-subject, .pr-subject {
    font-weight: 500;
    flex: 1;
  }

  .issue-meta, .pr-meta {
    font-size: 0.75rem;
    color: #6b7280;
    display: flex;
    gap: 0.75rem;
  }

  .pr-commit {
    font-family: monospace;
  }

  .issues-content, .prs-content {
    flex: 1;
    overflow-y: auto;
    padding: 2rem;
  }

  .issue-detail, .pr-detail {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .issue-detail h3, .pr-detail h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
  }

  .issue-meta-detail, .pr-meta-detail {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: #6b7280;
  }

  .issue-body, .pr-body {
    line-height: 1.6;
    color: #374151;
  }

  .verification-status {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    margin-left: 0.5rem;
  }

  .verification-status.verified {
    background: #d1fae5;
    color: #065f46;
  }

  .verification-status.unverified {
    background: #fee2e2;
    color: #991b1b;
  }
</style>
