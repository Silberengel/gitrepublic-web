<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from '../../lib/services/nostr/nip07-signer.js';
  import { decodeNostrAddress } from '../../lib/services/nostr/nip19-utils.js';
  import { NostrClient } from '../../lib/services/nostr/nostr-client.js';
  import { KIND } from '../../lib/types/nostr.js';
  import type { NostrEvent } from '../../lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';

  let nip07Available = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);

  // Form fields
  let repoName = $state('');
  let description = $state('');
  let cloneUrls = $state<string[]>(['']);
  let webUrls = $state<string[]>(['']);
  let maintainers = $state<string[]>(['']);
  let relays = $state<string[]>(['']);
  let blossoms = $state<string[]>(['']);
  let tags = $state<string[]>(['']);
  let documentation = $state<string[]>(['']);
  let alt = $state('');
  let imageUrl = $state('');
  let bannerUrl = $state('');
  let earliestCommit = $state('');
  let isPrivate = $state(false);
  let isFork = $state(false);
  let forkOriginalRepo = $state(''); // Original repo identifier: npub/repo, naddr, or 30617:owner:repo format
  let addClientTag = $state(true); // Add ["client", "gitrepublic-web"] tag
  let existingRepoRef = $state(''); // hex, nevent, or naddr
  let loadingExisting = $state(false);

  // URL preview state
  let previewingUrlIndex = $state<number | null>(null);
  let previewUrl = $state<string | null>(null);
  let previewError = $state<string | null>(null);
  let previewLoading = $state(false);
  let previewTimeout: ReturnType<typeof setTimeout> | null = null;

  // Lookup state
  let lookupLoading = $state<{ [key: string]: boolean }>({});
  let lookupError = $state<{ [key: string]: string | null }>({});
  let lookupResults = $state<{ [key: string]: any }>({});

  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '../../lib/config.js';

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const searchClient = new NostrClient(DEFAULT_NOSTR_SEARCH_RELAYS);

  onMount(() => {
    nip07Available = isNIP07Available();
  });

  function addCloneUrl() {
    cloneUrls = [...cloneUrls, ''];
  }

  function removeCloneUrl(index: number) {
    cloneUrls = cloneUrls.filter((_, i) => i !== index);
  }

  function updateCloneUrl(index: number, value: string) {
    const newUrls = [...cloneUrls];
    newUrls[index] = value;
    cloneUrls = newUrls;
  }

  function addWebUrl() {
    webUrls = [...webUrls, ''];
  }

  function removeWebUrl(index: number) {
    webUrls = webUrls.filter((_, i) => i !== index);
  }

  function updateWebUrl(index: number, value: string) {
    const newUrls = [...webUrls];
    newUrls[index] = value;
    webUrls = newUrls;
  }

  function addMaintainer() {
    maintainers = [...maintainers, ''];
  }

  function removeMaintainer(index: number) {
    maintainers = maintainers.filter((_, i) => i !== index);
  }

  function updateMaintainer(index: number, value: string) {
    const newMaintainers = [...maintainers];
    newMaintainers[index] = value;
    maintainers = newMaintainers;
  }

  function addRelay() {
    relays = [...relays, ''];
  }

  function removeRelay(index: number) {
    relays = relays.filter((_, i) => i !== index);
  }

  function updateRelay(index: number, value: string) {
    const newRelays = [...relays];
    newRelays[index] = value;
    relays = newRelays;
  }

  function addBlossom() {
    blossoms = [...blossoms, ''];
  }

  function removeBlossom(index: number) {
    blossoms = blossoms.filter((_, i) => i !== index);
  }

  function updateBlossom(index: number, value: string) {
    const newBlossoms = [...blossoms];
    newBlossoms[index] = value;
    blossoms = newBlossoms;
  }

  function addTag() {
    tags = [...tags, ''];
  }

  function removeTag(index: number) {
    tags = tags.filter((_, i) => i !== index);
  }

  function updateTag(index: number, value: string) {
    const newTags = [...tags];
    newTags[index] = value;
    tags = newTags;
  }

  function addDocumentation() {
    documentation = [...documentation, ''];
  }

  function removeDocumentation(index: number) {
    documentation = documentation.filter((_, i) => i !== index);
  }

  function updateDocumentation(index: number, value: string) {
    const newDocs = [...documentation];
    newDocs[index] = value;
    documentation = newDocs;
  }

  async function handleWebUrlHover(index: number, url: string) {
    // Clear any existing timeout
    if (previewTimeout) {
      clearTimeout(previewTimeout);
    }

    // Only preview if URL looks valid
    if (!url.trim() || !isValidUrl(url.trim())) {
      return;
    }

    // Delay preview to avoid showing on quick mouse movements
    previewTimeout = setTimeout(async () => {
      previewingUrlIndex = index;
      previewUrl = url.trim();
      previewError = null;
      previewLoading = true;

      // Try to verify the URL exists by attempting to fetch it
      // Note: CORS may prevent this, but we'll still show the iframe preview
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
        
        const response = await fetch(url.trim(), {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-cache',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        // With no-cors mode, we can't read the status, but if it doesn't throw, proceed
        previewError = null;
      } catch (err) {
        // If fetch fails, it might be CORS, network error, or 404
        // The iframe will show the actual error to the user
        if (err instanceof Error && err.name === 'AbortError') {
          previewError = 'Request timed out - URL may be slow or unreachable';
        } else {
          previewError = 'Unable to verify URL - preview may show an error if URL is invalid';
        }
      } finally {
        previewLoading = false;
      }
    }, 500); // 500ms delay before showing preview
  }

  function handleWebUrlLeave() {
    if (previewTimeout) {
      clearTimeout(previewTimeout);
    }
    previewingUrlIndex = null;
    previewUrl = null;
    previewError = null;
    previewLoading = false;
  }

  function isValidUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // Validation functions
  function validateCloneUrl(url: string): string | null {
    if (!url.trim()) return null; // Empty is OK
    if (!isValidUrl(url.trim())) {
      return 'Invalid URL format. Must start with http:// or https://';
    }
    if (!url.trim().endsWith('.git') && !url.trim().includes('/')) {
      return 'Clone URL should end with .git or be a valid repository URL';
    }
    return null;
  }

  function validateWebUrl(url: string): string | null {
    if (!url.trim()) return null; // Empty is OK
    if (!isValidUrl(url.trim())) {
      return 'Invalid URL format. Must start with http:// or https://';
    }
    return null;
  }

  function validateMaintainer(maintainer: string): string | null {
    if (!maintainer.trim()) return null; // Empty is OK
    // Check if it's a valid npub or hex pubkey
    try {
      if (maintainer.startsWith('npub')) {
        nip19.decode(maintainer);
        return null;
      } else if (maintainer.length === 64 && /^[0-9a-f]+$/i.test(maintainer)) {
        return null; // Valid hex pubkey
      } else {
        return 'Invalid maintainer format. Use npub1... or 64-character hex pubkey';
      }
    } catch {
      return 'Invalid maintainer format. Use npub1... or 64-character hex pubkey';
    }
  }

  function validateDocumentation(doc: string): string | null {
    if (!doc.trim()) return null; // Empty is OK
    // Check if it's in naddr format or 30618:pubkey:identifier format
    if (doc.startsWith('naddr')) {
      try {
        const decoded = nip19.decode(doc);
        if (decoded.type === 'naddr') return null;
      } catch {
        return 'Invalid naddr format';
      }
    } else if (/^\d+:[0-9a-f]{64}:[a-zA-Z0-9_-]+$/.test(doc)) {
      return null; // Valid kind:pubkey:identifier format
    }
    return 'Invalid documentation format. Use naddr1... or kind:pubkey:identifier';
  }

  function validateImageUrl(url: string): string | null {
    if (!url.trim()) return null; // Empty is OK
    if (!isValidUrl(url.trim())) {
      return 'Invalid URL format. Must start with http:// or https://';
    }
    // Check if it's likely an image URL
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    const lowerUrl = url.toLowerCase();
    if (!imageExtensions.some(ext => lowerUrl.includes(ext)) && !lowerUrl.includes('image') && !lowerUrl.includes('img')) {
      return 'Warning: URL does not appear to be an image';
    }
    return null;
  }

  // Lookup functions
  // Use only default search relays for lookups to avoid connecting to random/unreachable user relays
  function getSearchRelays(): string[] {
    return DEFAULT_NOSTR_SEARCH_RELAYS;
  }

  async function lookupRepoAnnouncement(query: string, fieldName: string) {
    const lookupKey = `repo-${fieldName}`;
    lookupLoading[lookupKey] = true;
    lookupError[lookupKey] = null;
    lookupResults[lookupKey] = null;

    try {
      const relays = await getSearchRelays();
      const client = new NostrClient(relays);

      // Try to decode as naddr, nevent, or hex
      const decoded = decodeNostrAddress(query.trim());
      let events: NostrEvent[] = [];

      if (decoded) {
        if (decoded.type === 'note' && decoded.id) {
          events = await client.fetchEvents([{ ids: [decoded.id], limit: 10 }]);
        } else if (decoded.type === 'nevent' && decoded.id) {
          events = await client.fetchEvents([{ ids: [decoded.id], limit: 10 }]);
        } else if (decoded.type === 'naddr' && decoded.pubkey && decoded.kind && decoded.identifier) {
          events = await client.fetchEvents([
            {
              kinds: [decoded.kind],
              authors: [decoded.pubkey],
              '#d': [decoded.identifier],
              limit: 10
            }
          ]);
        }
      }

      // Also search by name or d-tag if query doesn't look like an address
      if (events.length === 0 && !query.startsWith('naddr') && !query.startsWith('nevent') && !/^[0-9a-f]{64}$/i.test(query)) {
        const repoEvents = await client.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            limit: 20
          }
        ]);

        const searchLower = query.toLowerCase();
        events = repoEvents.filter(event => {
          const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
          const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
          return name.toLowerCase().includes(searchLower) || dTag.toLowerCase().includes(searchLower);
        });
      }

      if (events.length === 0) {
        lookupError[lookupKey] = 'No repository announcements found';
      } else {
        lookupResults[lookupKey] = events;
      }
    } catch (err) {
      lookupError[lookupKey] = `Lookup failed: ${String(err)}`;
    } finally {
      lookupLoading[lookupKey] = false;
    }
  }

  async function lookupNpub(query: string, fieldName: string, index?: number) {
    const lookupKey = index !== undefined ? `npub-${fieldName}-${index}` : `npub-${fieldName}`;
    lookupLoading[lookupKey] = true;
    lookupError[lookupKey] = null;
    lookupResults[lookupKey] = null;

    try {
      // Try to decode as npub
      let pubkey: string | null = null;
      try {
        if (query.startsWith('npub')) {
          const decoded = nip19.decode(query);
          if (decoded.type === 'npub') {
            pubkey = decoded.data as string;
          }
        } else if (query.length === 64 && /^[0-9a-f]+$/i.test(query)) {
          pubkey = query;
        }
      } catch {
        // Invalid format
      }

      if (!pubkey) {
        // Search for npubs by name (requires kind 0 metadata)
        const relays = getSearchRelays();
        const client = new NostrClient(relays);
        
        // Search for profiles
        const profileEvents = await client.fetchEvents([
          {
            kinds: [0], // Metadata events
            limit: 20
          }
        ]);

        const searchLower = query.toLowerCase();
        const matches = profileEvents.filter(event => {
          try {
            const content = JSON.parse(event.content);
            const name = content.name || content.display_name || '';
            return name.toLowerCase().includes(searchLower);
          } catch {
            return false;
          }
        });

        if (matches.length > 0) {
          lookupResults[lookupKey] = matches.map(e => {
            try {
              const content = JSON.parse(e.content);
              return {
                pubkey: e.pubkey,
                npub: nip19.npubEncode(e.pubkey),
                name: content.name || content.display_name || 'Unknown',
                about: content.about || '',
                picture: content.picture || ''
              };
            } catch {
              return {
                pubkey: e.pubkey,
                npub: nip19.npubEncode(e.pubkey),
                name: 'Unknown'
              };
            }
          });
        } else {
          lookupError[lookupKey] = 'No profiles found matching the query';
        }
      } else {
        // Valid pubkey, try to fetch profile
        const relays = getSearchRelays();
        const client = new NostrClient(relays);
        const profileEvents = await client.fetchEvents([
          {
            kinds: [0],
            authors: [pubkey],
            limit: 1
          }
        ]);

        let profileData: any = {
          pubkey,
          npub: query.startsWith('npub') ? query : nip19.npubEncode(pubkey)
        };

        if (profileEvents.length > 0) {
          try {
            const content = JSON.parse(profileEvents[0].content);
            profileData.name = content.name || content.display_name || '';
            profileData.about = content.about || '';
            profileData.picture = content.picture || '';
          } catch {
            // Invalid JSON, use defaults
          }
        }

        lookupResults[lookupKey] = [profileData];
      }
    } catch (err) {
      lookupError[lookupKey] = `Lookup failed: ${String(err)}`;
    } finally {
      lookupLoading[lookupKey] = false;
    }
  }

  async function lookupNevent(query: string, fieldName: string) {
    const lookupKey = `nevent-${fieldName}`;
    lookupLoading[lookupKey] = true;
    lookupError[lookupKey] = null;
    lookupResults[lookupKey] = null;

    try {
      const relays = await getSearchRelays();
      const client = new NostrClient(relays);

      let events: NostrEvent[] = [];
      const decoded = decodeNostrAddress(query.trim());

      if (decoded && decoded.id) {
        events = await client.fetchEvents([{ ids: [decoded.id], limit: 10 }]);
      } else if (/^[0-9a-f]{64}$/i.test(query.trim())) {
        // Hex event ID
        events = await client.fetchEvents([{ ids: [query.trim()], limit: 10 }]);
      }

      if (events.length === 0) {
        lookupError[lookupKey] = 'No events found';
      } else {
        lookupResults[lookupKey] = events;
      }
    } catch (err) {
      lookupError[lookupKey] = `Lookup failed: ${String(err)}`;
    } finally {
      lookupLoading[lookupKey] = false;
    }
  }

  function selectRepoResult(result: NostrEvent, fieldName: string) {
    if (fieldName === 'existingRepoRef') {
      existingRepoRef = result.id;
      loadExistingRepo();
    } else if (fieldName === 'forkOriginalRepo') {
      // Convert to naddr format if possible
      const dTag = result.tags.find(t => t[0] === 'd')?.[1];
      if (dTag) {
        try {
          const naddr = nip19.naddrEncode({
            pubkey: result.pubkey,
            kind: result.kind,
            identifier: dTag,
            relays: []
          });
          forkOriginalRepo = naddr;
        } catch {
          forkOriginalRepo = `${result.kind}:${result.pubkey}:${dTag}`;
        }
      }
    }
    lookupResults[`repo-${fieldName}`] = null;
  }

  function selectNpubResult(result: { pubkey: string; npub: string; name?: string; about?: string; picture?: string }, fieldName: string, index?: number) {
    if (fieldName === 'maintainers' && index !== undefined) {
      updateMaintainer(index, result.npub);
    }
    const lookupKey = index !== undefined ? `npub-${fieldName}-${index}` : `npub-${fieldName}`;
    lookupResults[lookupKey] = null;
  }

  function clearLookupResults(key: string) {
    lookupResults[key] = null;
    lookupError[key] = null;
  }

  async function loadExistingRepo() {
    if (!existingRepoRef.trim()) return;

    loadingExisting = true;
    error = null;

    try {
      const decoded = decodeNostrAddress(existingRepoRef.trim());
      if (!decoded) {
        error = 'Invalid format. Please provide a hex event ID, nevent, or naddr.';
        loadingExisting = false;
        return;
      }

      let event: NostrEvent | null = null;

      if (decoded.type === 'note' && decoded.id) {
        // Fetch by event ID
        const events = await nostrClient.fetchEvents([{ ids: [decoded.id], limit: 1 }]);
        event = events[0] || null;
      } else if (decoded.type === 'nevent' && decoded.id) {
        // Fetch by event ID
        const events = await nostrClient.fetchEvents([{ ids: [decoded.id], limit: 1 }]);
        event = events[0] || null;
      } else if (decoded.type === 'naddr' && decoded.pubkey && decoded.kind && decoded.identifier) {
        // Fetch parameterized replaceable event
        const events = await nostrClient.fetchEvents([
          {
            kinds: [decoded.kind],
            authors: [decoded.pubkey],
            '#d': [decoded.identifier],
            limit: 1
          }
        ]);
        event = events[0] || null;
      }

      if (!event) {
        error = 'Repository announcement not found. Make sure it exists on the relays.';
        loadingExisting = false;
        return;
      }

      if (event.kind !== KIND.REPO_ANNOUNCEMENT) {
        error = `The provided event is not a repository announcement (kind ${KIND.REPO_ANNOUNCEMENT}).`;
        loadingExisting = false;
        return;
      }

      // Populate form with existing data
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
      const nameTag = event.tags.find(t => t[0] === 'name')?.[1] || '';
      const descTag = event.tags.find(t => t[0] === 'description')?.[1] || '';
      const imageTag = event.tags.find(t => t[0] === 'image')?.[1] || '';
      const bannerTag = event.tags.find(t => t[0] === 'banner')?.[1] || '';
      const privateTag = event.tags.find(t => (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private'));

      repoName = nameTag || dTag;
      description = descTag;
      imageUrl = imageTag;
      bannerUrl = bannerTag;
      isPrivate = !!privateTag;

      // Extract clone URLs - handle both formats: separate tags and multiple values in one tag
      const urls: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'clone') {
          for (let i = 1; i < tag.length; i++) {
            const url = tag[i];
            if (url && typeof url === 'string' && url.trim()) {
              urls.push(url.trim());
            }
          }
        }
      }
      cloneUrls = urls.length > 0 ? urls : [''];

      // Extract web URLs - handle both formats
      const webUrlsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'web') {
          for (let i = 1; i < tag.length; i++) {
            const url = tag[i];
            if (url && typeof url === 'string' && url.trim()) {
              webUrlsList.push(url.trim());
            }
          }
        }
      }
      webUrls = webUrlsList.length > 0 ? webUrlsList : [''];

      // Extract maintainers - handle both formats
      const maintainersList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'maintainers') {
          for (let i = 1; i < tag.length; i++) {
            const maintainer = tag[i];
            if (maintainer && typeof maintainer === 'string' && maintainer.trim()) {
              maintainersList.push(maintainer.trim());
            }
          }
        }
      }
      maintainers = maintainersList.length > 0 ? maintainersList : [''];

      // Extract relays
      const relaysList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'relays') {
          for (let i = 1; i < tag.length; i++) {
            const relay = tag[i];
            if (relay && typeof relay === 'string' && relay.trim()) {
              relaysList.push(relay.trim());
            }
          }
        }
      }
      relays = relaysList.length > 0 ? relaysList : [''];

      // Extract blossoms
      const blossomsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'blossoms') {
          for (let i = 1; i < tag.length; i++) {
            const blossom = tag[i];
            if (blossom && typeof blossom === 'string' && blossom.trim()) {
              blossomsList.push(blossom.trim());
            }
          }
        }
      }
      blossoms = blossomsList.length > 0 ? blossomsList : [''];

      // Extract tags/labels
      const tagsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 't' && tag[1] && tag[1] !== 'private' && tag[1] !== 'fork') {
          tagsList.push(tag[1]);
        }
      }
      tags = tagsList.length > 0 ? tagsList : [''];

      // Extract documentation - handle relay hints correctly
      // Only treat values as multiple entries if they are in the same format
      // If a value looks like a relay URL (wss:// or ws://), it's a relay hint for the previous value
      const docsList: string[] = [];
      const isRelayUrl = (value: string): boolean => {
        return typeof value === 'string' && (value.startsWith('wss://') || value.startsWith('ws://'));
      };
      
      const getDocFormat = (value: string): string | null => {
        // Check if it's naddr format (starts with naddr1)
        if (value.startsWith('naddr1')) return 'naddr';
        // Check if it's kind:pubkey:identifier format
        if (/^\d+:[0-9a-f]{64}:[a-zA-Z0-9_-]+$/.test(value)) return 'kind:pubkey:identifier';
        return null;
      };
      
      for (const tag of event.tags) {
        if (tag[0] === 'documentation') {
          let i = 1;
          
          while (i < tag.length) {
            const value = tag[i];
            if (!value || typeof value !== 'string' || !value.trim()) {
              i++;
              continue;
            }
            
            const trimmed = value.trim();
            
            // Skip relay URLs (they're hints, not entries)
            if (isRelayUrl(trimmed)) {
              i++;
              continue;
            }
            
            // Check if this is a documentation reference
            const format = getDocFormat(trimmed);
            if (!format) {
              i++;
              continue; // Skip invalid formats
            }
            
            // Check if next value is a relay URL (hint for this entry)
            const nextValue = i + 1 < tag.length ? tag[i + 1] : null;
            if (nextValue && typeof nextValue === 'string' && isRelayUrl(nextValue.trim())) {
              // Current value has a relay hint - store just the doc reference, skip the relay
              docsList.push(trimmed);
              i += 2; // Skip both the doc and the relay hint
              continue;
            }
            
            // Check if we have multiple entries in the same format
            // Collect all consecutive entries of the same format
            const sameFormatEntries: string[] = [trimmed];
            let j = i + 1;
            while (j < tag.length) {
              const nextVal = tag[j];
              if (!nextVal || typeof nextVal !== 'string' || !nextVal.trim()) {
                j++;
                continue;
              }
              
              const nextTrimmed = nextVal.trim();
              
              // Stop if we hit a relay URL (it's a hint for the previous entry)
              if (isRelayUrl(nextTrimmed)) {
                break;
              }
              
              // Check if it's the same format
              const nextFormat = getDocFormat(nextTrimmed);
              if (nextFormat === format) {
                sameFormatEntries.push(nextTrimmed);
                j++;
              } else {
                // Different format - stop collecting
                break;
              }
            }
            
            // If we have multiple entries in the same format, add them all
            // Otherwise, just add the single entry
            docsList.push(...sameFormatEntries);
            i = j; // Move to the next unprocessed value
          }
        }
      }
      documentation = docsList.length > 0 ? docsList : [''];

      // Extract alt tag
      const altTag = event.tags.find(t => t[0] === 'alt');
      alt = altTag?.[1] || '';

      // Extract fork information
      const aTag = event.tags.find(t => t[0] === 'a' && t[1]?.startsWith('30617:'));
      if (aTag?.[1]) {
        forkOriginalRepo = aTag[1];
        isFork = true;
      } else {
        // Check if marked as fork via tag
        isFork = event.tags.some(t => t[0] === 't' && t[1] === 'fork');
        if (isFork) {
          // Try to construct from p tag if available
          const pTag = event.tags.find(t => t[0] === 'p' && t[1] && t[1] !== event.pubkey);
          if (pTag?.[1] && dTag) {
            // Construct a tag format: 30617:owner:repo
            forkOriginalRepo = `${KIND.REPO_ANNOUNCEMENT}:${pTag[1]}:${dTag}`;
          }
        }
      }

      // Extract earliest unique commit
      const rTag = event.tags.find(t => t[0] === 'r' && t[2] === 'euc');
      earliestCommit = rTag?.[1] || '';

      // Check if client tag exists
      addClientTag = !event.tags.some(t => t[0] === 'client' && t[1] === 'gitrepublic-web');

    } catch (e) {
      error = `Failed to load repository: ${String(e)}`;
    } finally {
      loadingExisting = false;
    }
  }

  async function submit() {
    if (!nip07Available) {
      error = 'NIP-07 extension is required. Please install a Nostr browser extension.';
      return;
    }

    if (!repoName.trim()) {
      error = 'Repository name is required.';
      return;
    }

    // Validate all fields
    const validationErrors: string[] = [];

    // Validate clone URLs
    for (let i = 0; i < cloneUrls.length; i++) {
      const urlError = validateCloneUrl(cloneUrls[i]);
      if (urlError) {
        validationErrors.push(`Clone URL ${i + 1}: ${urlError}`);
      }
    }

    // Validate web URLs
    for (let i = 0; i < webUrls.length; i++) {
      const urlError = validateWebUrl(webUrls[i]);
      if (urlError) {
        validationErrors.push(`Web URL ${i + 1}: ${urlError}`);
      }
    }

    // Validate maintainers
    for (let i = 0; i < maintainers.length; i++) {
      const maintainerError = validateMaintainer(maintainers[i]);
      if (maintainerError) {
        validationErrors.push(`Maintainer ${i + 1}: ${maintainerError}`);
      }
    }

    // Validate documentation
    for (let i = 0; i < documentation.length; i++) {
      const docError = validateDocumentation(documentation[i]);
      if (docError) {
        validationErrors.push(`Documentation ${i + 1}: ${docError}`);
      }
    }

    // Validate image URLs
    if (imageUrl.trim()) {
      const imageError = validateImageUrl(imageUrl);
      if (imageError) {
        validationErrors.push(`Image URL: ${imageError}`);
      }
    }

    if (bannerUrl.trim()) {
      const bannerError = validateImageUrl(bannerUrl);
      if (bannerError) {
        validationErrors.push(`Banner URL: ${bannerError}`);
      }
    }

    if (validationErrors.length > 0) {
      error = 'Validation errors:\n' + validationErrors.join('\n');
      return;
    }

    loading = true;
    error = null;

    try {
      const pubkey = await getPublicKeyWithNIP07();
      const npub = nip19.npubEncode(pubkey);

      // Normalize repo name to d-tag format
      const dTag = repoName
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

      // Get git domain from layout data
      const gitDomain = $page.data.gitDomain || 'localhost:6543';
      const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
      const gitUrl = `${protocol}://${gitDomain}/${npub}/${dTag}.git`;

      // Try to get Tor .onion address and add it to clone URLs
      let torOnionUrl: string | null = null;
      try {
        const torResponse = await fetch('/api/tor/onion');
        if (torResponse.ok) {
          const torData = await torResponse.json();
          if (torData.available && torData.onion) {
            torOnionUrl = `http://${torData.onion}/${npub}/${dTag}.git`;
          }
        }
      } catch {
        // Tor not available, continue without it
      }

      // Build clone URLs - always include our domain, and Tor .onion if available
      const allCloneUrls = [
        gitUrl,
        ...(torOnionUrl ? [torOnionUrl] : []), // Add Tor .onion URL if available
        ...cloneUrls.filter(url => url.trim() && !url.includes(gitDomain) && !url.includes('.onion'))
      ];

      // Build web URLs
      const allWebUrls = webUrls.filter(url => url.trim());

      // Build maintainers list
      const allMaintainers = maintainers.filter(m => m.trim());

      // Build relays list - combine user relays with default relays
      const allRelays = [
        ...relays.filter(r => r.trim()),
        ...DEFAULT_NOSTR_RELAYS.filter(r => !relays.includes(r))
      ];

      // Build blossoms list
      const allBlossoms = blossoms.filter(b => b.trim());

      // Build documentation list
      const allDocumentation = documentation.filter(d => d.trim());

      // Build tags/labels (excluding 'private' and 'fork' which are handled separately)
      const allTags = tags.filter(t => t.trim() && t !== 'private' && t !== 'fork');

      // Build event tags - use single tag with multiple values (NIP-34 format)
      const eventTags: string[][] = [
        ['d', dTag],
        ['name', repoName],
        ...(description ? [['description', description]] : []),
        ...(allCloneUrls.length > 0 ? [['clone', ...allCloneUrls]] : []), // Single tag with all clone URLs
        ...(allWebUrls.length > 0 ? [['web', ...allWebUrls]] : []), // Single tag with all web URLs
        ...(allMaintainers.length > 0 ? [['maintainers', ...allMaintainers]] : []), // Single tag with all maintainers
        ...(allRelays.length > 0 ? [['relays', ...allRelays]] : []), // Single tag with all relays
        ...(allBlossoms.length > 0 ? [['blossoms', ...allBlossoms]] : []), // Single tag with all blossoms
        ...allDocumentation.map(d => ['documentation', d]), // Documentation can have relay hints, so keep separate
        ...allTags.map(t => ['t', t]),
        ...(imageUrl.trim() ? [['image', imageUrl.trim()]] : []),
        ...(bannerUrl.trim() ? [['banner', bannerUrl.trim()]] : []),
        ...(alt.trim() ? [['alt', alt.trim()]] : []),
        ...(earliestCommit.trim() ? [['r', earliestCommit.trim(), 'euc']] : [])
      ];

      // Add fork tags if this is a fork
      if (isFork && forkOriginalRepo.trim()) {
        let forkAddress = forkOriginalRepo.trim();
        let forkOwnerPubkey: string | null = null;
        let isValidFormat = false;

        // Parse the fork identifier - could be:
        // 1. naddr format (decode to get pubkey and repo)
        // 2. npub/repo format (need to construct a tag)
        // 3. Already in 30617:owner:repo format
        if (forkAddress.startsWith('naddr')) {
          try {
            const decoded = nip19.decode(forkAddress);
            if (decoded.type === 'naddr') {
              const data = decoded.data as { pubkey: string; kind: number; identifier: string };
              if (data.pubkey && data.identifier) {
                forkAddress = `${KIND.REPO_ANNOUNCEMENT}:${data.pubkey}:${data.identifier}`;
                forkOwnerPubkey = data.pubkey;
                isValidFormat = true;
              }
            }
          } catch {
            // Invalid naddr, will be caught by validation below
          }
        } else if (forkAddress.includes('/') && !forkAddress.startsWith('30617:')) {
          // Assume npub/repo format
          const parts = forkAddress.split('/');
          if (parts.length === 2 && parts[1].trim()) {
            try {
              const decoded = nip19.decode(parts[0]);
              if (decoded.type === 'npub') {
                forkOwnerPubkey = decoded.data as string;
                forkAddress = `${KIND.REPO_ANNOUNCEMENT}:${forkOwnerPubkey}:${parts[1].trim()}`;
                isValidFormat = true;
              }
            } catch {
              // Invalid npub, try as hex pubkey
              if (parts[0].length === 64 && /^[0-9a-f]+$/i.test(parts[0])) {
                forkOwnerPubkey = parts[0];
                forkAddress = `${KIND.REPO_ANNOUNCEMENT}:${forkOwnerPubkey}:${parts[1].trim()}`;
                isValidFormat = true;
              }
            }
          }
        } else if (forkAddress.startsWith('30617:')) {
          // Already in correct format, validate and extract owner pubkey
          const parts = forkAddress.split(':');
          if (parts.length >= 3 && parts[1] && parts[2]) {
            forkOwnerPubkey = parts[1];
            isValidFormat = true;
          }
        }

        // Validate the final format: must be 30617:pubkey:repo
        // Always validate regardless of parsing success to catch any edge cases
        const parts = forkAddress.split(':');
        if (parts.length >= 3) {
          const kind = parts[0];
          const pubkey = parts[1];
          const repo = parts[2];

          // Validate format
          if (kind !== String(KIND.REPO_ANNOUNCEMENT)) {
            isValidFormat = false;
          } else if (!pubkey || pubkey.length !== 64 || !/^[0-9a-f]+$/i.test(pubkey)) {
            isValidFormat = false;
          } else if (!repo || !repo.trim()) {
            isValidFormat = false;
          } else {
            // Format is valid, ensure isValidFormat is true
            isValidFormat = true;
          }
        } else {
          isValidFormat = false;
        }

        if (!isValidFormat) {
          error = 'Invalid fork repository format. Please use one of:\n' +
            '• naddr format: naddr1...\n' +
            '• npub/repo format: npub1abc.../repo-name\n' +
            '• Repository address: 30617:owner-pubkey:repo-name';
          loading = false;
          return;
        }

        // Add a tag (required for fork identification)
        eventTags.push(['a', forkAddress]);

        // Add p tag if we have the owner pubkey
        if (forkOwnerPubkey) {
          eventTags.push(['p', forkOwnerPubkey]);
        }

        // Add 'fork' tag if not already in tags
        if (!allTags.includes('fork')) {
          eventTags.push(['t', 'fork']);
        }
      }

      // Add private tag if enabled
      if (isPrivate) {
        eventTags.push(['private', 'true']);
      }

      // Add client tag if enabled
      if (addClientTag) {
        eventTags.push(['client', 'gitrepublic-web']);
      }

      // Build event
      const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.REPO_ANNOUNCEMENT,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Empty per NIP-34
        tags: eventTags
      };

      // Sign with NIP-07
      const signedEvent = await signEventWithNIP07(eventTemplate);

      // Get user's inbox/outbox relays (from kind 10002) using full relay set to find newest
      const { getUserRelays } = await import('../../lib/services/nostr/user-relays.js');
      // Use comprehensive relay set to ensure we get the newest kind 10002 event
      const fullRelaySet = combineRelays([], [...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS]);
      const fullRelayClient = new NostrClient(fullRelaySet);
      const { inbox, outbox } = await getUserRelays(pubkey, fullRelayClient);
      
      // Combine user's outbox with default relays
      const userRelays = combineRelays(outbox);

      // Publish repository announcement
      const result = await nostrClient.publishEvent(signedEvent, userRelays);

      if (result.success.length > 0) {
        // Create and publish initial ownership proof (self-transfer event)
        const { OwnershipTransferService } = await import('../../lib/services/nostr/ownership-transfer-service.js');
        const ownershipService = new OwnershipTransferService(userRelays);
        
        const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(pubkey, dTag);
        const signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
        
        // Publish initial ownership event (don't fail if this fails, announcement is already published)
        await nostrClient.publishEvent(signedOwnershipEvent, userRelays).catch(err => {
          console.warn('Failed to publish initial ownership event:', err);
        });

        success = true;
        setTimeout(() => {
          goto('/');
        }, 2000);
      } else {
        error = 'Failed to publish to any relays.';
      }

    } catch (e) {
      error = `Failed to create repository announcement: ${String(e)}`;
    } finally {
      loading = false;
    }
  }
</script>

<div class="container">
  <header>
    <h1>Create or Update Repository Announcement</h1>
  </header>

  <main>

    {#if !nip07Available}
      <div class="warning">
        <p>NIP-07 browser extension is required to sign repository announcements.</p>
        <p>Please install a Nostr browser extension (like Alby, nos2x, or similar).</p>
      </div>
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {/if}

    {#if success}
      <div class="success">
        Repository announcement published successfully! Redirecting...
      </div>
    {/if}

    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <div class="form-group">
        <label for="existing-repo-ref">
          Load Existing Repository (optional)
          <small>Enter hex event ID, nevent, or naddr to update an existing announcement</small>
        </label>
        <div class="input-group">
          <input
            id="existing-repo-ref"
            type="text"
            bind:value={existingRepoRef}
            placeholder="hex event ID, nevent1..., or naddr1..."
            disabled={loading || loadingExisting}
          />
          <button
            type="button"
            onclick={() => lookupRepoAnnouncement(existingRepoRef || '', 'existingRepoRef')}
            disabled={loading || loadingExisting || !existingRepoRef.trim()}
            class="lookup-button"
            title="Search for repository announcements (supports hex ID, nevent, naddr, or search by name)"
          >
            {#if lookupLoading['repo-existingRepoRef']}
              <span class="loading-text">Loading...</span>
            {:else}
              <svg class="icon-small" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <path d="m21 21-4.35-4.35"/>
              </svg>
            {/if}
          </button>
          <button
            type="button"
            onclick={loadExistingRepo}
            disabled={loading || loadingExisting || !existingRepoRef.trim()}
          >
            {loadingExisting ? 'Loading...' : 'Load'}
          </button>
        </div>
        {#if lookupError['repo-existingRepoRef']}
          <div class="lookup-error">{lookupError['repo-existingRepoRef']}</div>
        {/if}
        {#if lookupResults['repo-existingRepoRef']}
          <div class="lookup-results">
            <div class="lookup-results-header">
              <span>Found {lookupResults['repo-existingRepoRef'].length} repository announcement(s):</span>
              <button
                type="button"
                onclick={() => clearLookupResults('repo-existingRepoRef')}
                class="clear-lookup-button"
                title="Clear results"
              >
                <img src="/icons/x.svg" alt="Clear" class="icon-small" />
              </button>
            </div>
            {#each lookupResults['repo-existingRepoRef'] as result}
              {@const nameTag = result.tags.find((t: string[]) => t[0] === 'name')?.[1]}
              {@const dTag = result.tags.find((t: string[]) => t[0] === 'd')?.[1]}
              {@const descTag = result.tags.find((t: string[]) => t[0] === 'description')?.[1]}
              {@const imageTag = result.tags.find((t: string[]) => t[0] === 'image')?.[1]}
              {@const ownerNpub = nip19.npubEncode(result.pubkey)}
              {@const tags = result.tags.filter((t: string[]) => t[0] === 't' && t[1] && t[1] !== 'private' && t[1] !== 'fork').map((t: string[]) => t[1])}
              <div 
                class="lookup-result-item repo-result" 
                role="button"
                tabindex="0"
                onclick={() => selectRepoResult(result, 'existingRepoRef')}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectRepoResult(result, 'existingRepoRef');
                  }
                }}
              >
                <div class="result-header">
                  {#if imageTag}
                    <img src={imageTag} alt="" class="result-image" />
                  {/if}
                  <div class="result-info">
                    <strong>{nameTag || dTag || 'Unnamed'}</strong>
                    {#if dTag}
                      <small class="d-tag">d-tag: {dTag}</small>
                    {/if}
                    {#if descTag}
                      <p class="result-description">{descTag}</p>
                    {/if}
                    <div class="result-meta">
                      <small>Owner: {ownerNpub.slice(0, 16)}...</small>
                      <small>Event: {result.id.slice(0, 16)}...</small>
                    </div>
                    {#if tags.length > 0}
                      <div class="result-tags">
                        {#each tags as tag}
                          <span class="tag-badge">#{tag}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="form-group">
        <label for="repo-name">
          Repository Name *
          <small>Enter a normal name (e.g., "My Awesome Repo"). It will be automatically converted to a d-tag format (lowercase with hyphens, such as my-awesome-repo).</small>
        </label>
        <input
          id="repo-name"
          type="text"
          bind:value={repoName}
          placeholder="My Awesome Repo"
          required
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="description">
          Description
        </label>
        <textarea
          id="description"
          bind:value={description}
          placeholder="Repository description"
          rows={3}
          disabled={loading}
        ></textarea>
      </div>

      <div class="form-group">
        <div class="label">
          Clone URLs
          <small>{$page.data.gitDomain || 'localhost:6543'} will be added automatically, but you can add any existing ones here.</small>
        </div>
        {#each cloneUrls as url, index}
          <div class="input-group">
            <input
              type="text"
              value={url}
              oninput={(e) => updateCloneUrl(index, e.currentTarget.value)}
              placeholder="https://github.com/user/repo.git"
              disabled={loading}
            />
            {#if cloneUrls.length > 1}
              <button
                type="button"
                onclick={() => removeCloneUrl(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addCloneUrl}
          disabled={loading}
          class="add-button"
        >
          + Add Clone URL
        </button>
      </div>

      <div class="form-group">
        <div class="label">
          Web URLs (optional)
          <small>Webpage URLs for browsing the repository (e.g., GitHub/GitLab web interface). Hover over a URL to preview it.</small>
        </div>
        {#each webUrls as url, index}
          <div class="input-group url-preview-container">
            <input
              type="text"
              value={url}
              oninput={(e) => updateWebUrl(index, e.currentTarget.value)}
              onmouseenter={() => handleWebUrlHover(index, url)}
              onmouseleave={handleWebUrlLeave}
              placeholder="https://github.com/user/repo"
              disabled={loading}
            />
            {#if webUrls.length > 1}
              <button
                type="button"
                onclick={() => removeWebUrl(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
            {#if previewingUrlIndex === index && previewUrl}
              <div class="url-preview" role="tooltip">
                {#if previewLoading}
                  <div class="preview-loading">Loading preview...</div>
                {:else if previewError}
                  <div class="preview-error">
                    <strong>
                      <img src="/icons/alert-triangle.svg" alt="Warning" class="icon-inline" />
                      Warning:
                    </strong> {previewError}
                  </div>
                {/if}
                <iframe
                  src={previewUrl}
                  title="URL Preview"
                  class="preview-iframe"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                ></iframe>
                <div class="preview-url-display">{previewUrl}</div>
              </div>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addWebUrl}
          disabled={loading}
          class="add-button"
        >
          + Add Web URL
        </button>
      </div>

      <div class="form-group">
        <div class="label">
          Maintainers (optional)
          <small>Other maintainer pubkeys (npub or hex format). Example: npub1abc... or hex pubkey</small>
        </div>
        {#each maintainers as maintainer, index}
          <div class="input-group">
            <input
              type="text"
              value={maintainer}
              oninput={(e) => updateMaintainer(index, e.currentTarget.value)}
              placeholder="npub1abc... or hex pubkey"
              disabled={loading}
            />
            <button
              type="button"
              onclick={() => lookupNpub(maintainer || '', 'maintainers', index)}
              disabled={loading || !maintainer.trim()}
              class="lookup-button"
              title="Lookup npub or search by name"
            >
              {#if lookupLoading[`npub-maintainers-${index}`]}
                <span class="loading-text">Loading...</span>
              {:else}
                <svg class="icon-small" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="m21 21-4.35-4.35"/>
                </svg>
              {/if}
            </button>
            {#if maintainers.length > 1}
              <button
                type="button"
                onclick={() => removeMaintainer(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
          {#if lookupError[`npub-maintainers-${index}`]}
            <div class="lookup-error">{lookupError[`npub-maintainers-${index}`]}</div>
          {/if}
          {#if lookupResults[`npub-maintainers-${index}`]}
            <div class="lookup-results">
              <div class="lookup-results-header">
                <span>Found {lookupResults[`npub-maintainers-${index}`].length} profile(s):</span>
                <button
                  type="button"
                  onclick={() => clearLookupResults(`npub-maintainers-${index}`)}
                  class="clear-lookup-button"
                  title="Clear results"
                >
                  <img src="/icons/x.svg" alt="Clear" class="icon-small" />
                </button>
              </div>
              {#each lookupResults[`npub-maintainers-${index}`] as result}
                <div 
                  class="lookup-result-item profile-result" 
                  role="button"
                  tabindex="0"
                  onclick={() => selectNpubResult(result, 'maintainers', index)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectNpubResult(result, 'maintainers', index);
                    }
                  }}
                >
                  <div class="result-header">
                    {#if result.picture}
                      <img src={result.picture} alt="" class="result-avatar" />
                    {:else}
                      <div class="result-avatar-placeholder">
                        {(result.name || result.npub).slice(0, 2).toUpperCase()}
                      </div>
                    {/if}
                    <div class="result-info">
                      <strong>{result.name || 'Unknown'}</strong>
                      {#if result.about}
                        <p class="result-description">{result.about}</p>
                      {/if}
                      <small class="npub-display">{result.npub}</small>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/each}
        <button
          type="button"
          onclick={addMaintainer}
          disabled={loading}
          class="add-button"
        >
          + Add Maintainer
        </button>
      </div>

      <div class="form-group">
        <div class="label">
          Relays (optional)
          <small>Nostr relays that this repository will monitor for patches and issues. Default relays will be added automatically.</small>
        </div>
        {#each relays as relay, index}
          <div class="input-group">
            <input
              type="text"
              value={relay}
              oninput={(e) => updateRelay(index, e.currentTarget.value)}
              placeholder="wss://relay.example.com"
              disabled={loading}
            />
            {#if relays.length > 1}
              <button
                type="button"
                onclick={() => removeRelay(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addRelay}
          disabled={loading}
          class="add-button"
        >
          + Add Relay
        </button>
      </div>

      <div class="form-group">
        <div class="label">
          Blossoms (optional)
          <small>Blossom URLs for this repository. These are preserved but not actively used by GitRepublic.</small>
        </div>
        {#each blossoms as blossom, index}
          <div class="input-group">
            <input
              type="text"
              value={blossom}
              oninput={(e) => updateBlossom(index, e.currentTarget.value)}
              placeholder="https://example.com"
              disabled={loading}
            />
            {#if blossoms.length > 1}
              <button
                type="button"
                onclick={() => removeBlossom(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addBlossom}
          disabled={loading}
          class="add-button"
        >
          + Add Blossom
        </button>
      </div>

      <div class="form-group">
        <label for="image-url">
          Repository Image URL (optional)
          <small>URL to a repository image/logo. Example: https://example.com/repo-logo.png</small>
        </label>
        <input
          id="image-url"
          type="url"
          bind:value={imageUrl}
          placeholder="https://example.com/repo-logo.png"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="banner-url">
          Repository Banner URL (optional)
          <small>URL to a repository banner image. Example: https://example.com/repo-banner.png</small>
        </label>
        <input
          id="banner-url"
          type="url"
          bind:value={bannerUrl}
          placeholder="https://example.com/repo-banner.png"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="earliest-commit">
          Earliest Unique Commit ID (optional)
          <small>Root commit ID or first commit after a permanent fork. Used to identify forks. Example: abc123def456...</small>
        </label>
        <input
          id="earliest-commit"
          type="text"
          bind:value={earliestCommit}
          placeholder="abc123def456..."
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <div class="label">
          Tags/Labels (optional)
          <small>Hashtags or labels for the repository. Examples: "javascript", "web-app", "personal-fork" (indicates author isn't a maintainer)</small>
        </div>
        {#each tags as tag, index}
          <div class="input-group">
            <input
              type="text"
              value={tag}
              oninput={(e) => updateTag(index, e.currentTarget.value)}
              placeholder="javascript"
              disabled={loading}
            />
            {#if tags.length > 1}
              <button
                type="button"
                onclick={() => removeTag(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addTag}
          disabled={loading}
          class="add-button"
        >
          + Add Tag
        </button>
      </div>

      <div class="form-group">
        <label for="alt">
          Alt Text (optional)
          <small>Alternative text/description for the repository. Example: "git repository: Alexandria"</small>
        </label>
        <input
          id="alt"
          type="text"
          bind:value={alt}
          placeholder="git repository: My Awesome Repo"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <div class="label">
          Documentation (optional)
          <small>Documentation event addresses (naddr format). Example: 30818:fd208ee8c8f283780a9552896e4823cc9dc6bfd442063889577106940fd927c1:nkbip-01</small>
        </div>
        {#each documentation as doc, index}
          <div class="input-group">
            <input
              type="text"
              value={doc}
              oninput={(e) => updateDocumentation(index, e.currentTarget.value)}
              placeholder="30818:pubkey:d-tag"
              disabled={loading}
            />
            {#if documentation.length > 1}
              <button
                type="button"
                onclick={() => removeDocumentation(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addDocumentation}
          disabled={loading}
          class="add-button"
        >
          + Add Documentation
        </button>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={isFork}
            disabled={loading}
          />
          <div>
            <span>This is a Fork</span>
            <small>Check if this repository is a fork of another repository</small>
          </div>
        </label>
      </div>

      {#if isFork}
        <div class="form-group">
          <label for="fork-original-repo">
            Original Repository *
            <small>Identify the repository this is forked from. You can enter:<br/>
            • naddr format: naddr1...<br/>
            • npub/repo format: npub1abc.../repo-name<br/>
            • Repository address: 30617:owner-pubkey:repo-name</small>
          </label>
          <div class="input-group">
            <input
              id="fork-original-repo"
              type="text"
              bind:value={forkOriginalRepo}
              placeholder="npub1abc.../original-repo or naddr1..."
              required={isFork}
              disabled={loading}
            />
            <button
              type="button"
              onclick={() => lookupRepoAnnouncement(forkOriginalRepo || '', 'forkOriginalRepo')}
              disabled={loading || !forkOriginalRepo.trim()}
              class="lookup-button"
              title="Search for repository announcements"
            >
              {#if lookupLoading['repo-forkOriginalRepo']}
                <span class="loading-text">Loading...</span>
              {:else}
                <svg class="icon-small" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="m21 21-4.35-4.35"/>
                </svg>
              {/if}
            </button>
          </div>
          {#if lookupError['repo-forkOriginalRepo']}
            <div class="lookup-error">{lookupError['repo-forkOriginalRepo']}</div>
          {/if}
          {#if lookupResults['repo-forkOriginalRepo']}
            <div class="lookup-results">
              <div class="lookup-results-header">
                <span>Found {lookupResults['repo-forkOriginalRepo'].length} repository announcement(s):</span>
                <button
                  type="button"
                  onclick={() => clearLookupResults('repo-forkOriginalRepo')}
                  class="clear-lookup-button"
                  title="Clear results"
                >
                  <img src="/icons/x.svg" alt="Clear" class="icon-small" />
                </button>
              </div>
              {#each lookupResults['repo-forkOriginalRepo'] as result}
                {@const nameTag = result.tags.find((t: string[]) => t[0] === 'name')?.[1]}
                {@const dTag = result.tags.find((t: string[]) => t[0] === 'd')?.[1]}
                {@const descTag = result.tags.find((t: string[]) => t[0] === 'description')?.[1]}
                {@const imageTag = result.tags.find((t: string[]) => t[0] === 'image')?.[1]}
                {@const ownerNpub = nip19.npubEncode(result.pubkey)}
                {@const tags = result.tags.filter((t: string[]) => t[0] === 't' && t[1] && t[1] !== 'private' && t[1] !== 'fork').map((t: string[]) => t[1])}
                <div 
                  class="lookup-result-item repo-result" 
                  role="button"
                  tabindex="0"
                  onclick={() => selectRepoResult(result, 'forkOriginalRepo')}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectRepoResult(result, 'forkOriginalRepo');
                    }
                  }}
                >
                  <div class="result-header">
                    {#if imageTag}
                      <img src={imageTag} alt="" class="result-image" />
                    {/if}
                    <div class="result-info">
                      <strong>{nameTag || dTag || 'Unnamed'}</strong>
                      {#if dTag}
                        <small class="d-tag">d-tag: {dTag}</small>
                      {/if}
                      {#if descTag}
                        <p class="result-description">{descTag}</p>
                      {/if}
                      <div class="result-meta">
                        <small>Owner: {ownerNpub.slice(0, 16)}...</small>
                        <small>Event: {result.id.slice(0, 16)}...</small>
                      </div>
                      {#if tags.length > 0}
                        <div class="result-tags">
                          {#each tags as tag}
                            <span class="tag-badge">#{tag}</span>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={isPrivate}
            disabled={loading}
          />
          <div>
            <span>Private Repository</span>
            <small>Private repositories are hidden from public listings and can only be accessed by the owner and maintainers. Git clone/fetch operations require authentication.</small>
          </div>
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={addClientTag}
            disabled={loading}
          />
          <div>
            <span>Add Client Tag</span>
            <small>Add a client tag to identify this repository as created with GitRepublic (checked by default)</small>
          </div>
        </label>
      </div>

      <div class="form-actions">
        <button
          type="submit"
          disabled={loading || !nip07Available}
        >
          {loading ? 'Publishing...' : 'Publish Repository Announcement'}
        </button>
        <a href="/" class="cancel-link">Cancel</a>
      </div>
    </form>
  </main>
</div>

