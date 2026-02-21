<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { PublicMessagesService, type PublicMessage } from '$lib/services/nostr/public-messages-service.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import { userStore } from '$lib/stores/user-store.js';
  import { fetchUserProfile, extractProfileData } from '$lib/utils/user-profile.js';
  import { combineRelays } from '$lib/config.js';
  import { KIND, isEphemeralKind, isReplaceableKind } from '$lib/types/nostr.js';

  const npub = ($page.params as { npub?: string }).npub || '';

  // State
  let loading = $state(true);
  let error = $state<string | null>(null);
  let profileOwnerPubkeyHex = $state<string | null>(null);
  let viewerPubkeyHex = $state<string | null>(null);
  let repos = $state<NostrEvent[]>([]);
  let ownedRepos = $state<NostrEvent[]>([]);
  let maintainedRepos = $state<NostrEvent[]>([]);
  let favoriteRepos = $state<NostrEvent[]>([]);
  let userProfile = $state<{ name?: string; about?: string; picture?: string; banner?: string } | null>(null);
  let profileEvent = $state<NostrEvent | null>(null);
  let profileData = $state<any>(null);
  let profileTags = $state<Array<{ name: string; values: string[]; verified?: boolean[] }>>([]);
  let paymentTargets = $state<Array<{ type: string; authority: string; payto: string }>>([]);
  
  // Messages
  let activeTab = $state<'repos' | 'messages' | 'activity'>('repos');
  let messages = $state<PublicMessage[]>([]);
  let loadingMessages = $state(false);
  let messagesLoaded = $state(false); // Track if we've attempted to load messages
  let showSendMessageDialog = $state(false);
  let newMessageContent = $state('');
  let sendingMessage = $state(false);
  let messagesService: PublicMessagesService | null = null;

  // Activity
  let activityEvents = $state<NostrEvent[]>([]);
  let loadingActivity = $state(false);
  let activityLoaded = $state(false); // Track if we've attempted to load activity
  let showReplyDialog = $state(false);
  let replyingToEvent = $state<NostrEvent | null>(null);
  let replyContent = $state('');
  let sendingReply = $state(false);
  
  // Quoted events cache for messages - use array for better reactivity
  let quotedEvents = $state<NostrEvent[]>([]);
  
  // Helper to get quoted event by ID
  const getQuotedEvent = (eventId: string): NostrEvent | undefined => {
    return quotedEvents.find(e => e.id === eventId);
  };

  // Referenced events cache for activity (a-tags and e-tags) - use array for better reactivity
  let referencedEvents = $state<NostrEvent[]>([]);
  
  // Helper to get referenced event by ID or a-tag
  const getReferencedEvent = (eventId?: string, aTag?: string): NostrEvent | undefined => {
    if (eventId) {
      return referencedEvents.find(e => e.id === eventId);
    }
    if (aTag) {
      // Parse a-tag format: kind:pubkey:d-tag
      const parts = aTag.split(':');
      if (parts.length === 3) {
        const kind = parseInt(parts[0]);
        const pubkey = parts[1];
        const dTag = parts[2];
        return referencedEvents.find(e => 
          e.kind === kind && 
          e.pubkey === pubkey && 
          e.tags.find(t => t[0] === 'd' && t[1] === dTag)
        );
      }
    }
    return undefined;
  };

  // Nostr link cache for embedded events and profiles
  let nostrLinkEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkProfiles = $state<Map<string, string>>(new Map()); // npub -> pubkey hex

  // Parse nostr: links from content and extract IDs/pubkeys
  function parseNostrLinks(content: string): Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> {
    const links: Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> = [];
    const nostrLinkRegex = /nostr:(nevent1|naddr1|note1|npub1|profile1)[a-zA-Z0-9]+/g;
    let match;
    
    while ((match = nostrLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const prefix = match[1];
      let type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile';
      
      if (prefix === 'nevent1') type = 'nevent';
      else if (prefix === 'naddr1') type = 'naddr';
      else if (prefix === 'note1') type = 'note1';
      else if (prefix === 'npub1') type = 'npub';
      else if (prefix === 'profile1') type = 'profile';
      else continue;
      
      links.push({
        type,
        value: fullMatch,
        start: match.index,
        end: match.index + fullMatch.length
      });
    }
    
    return links;
  }

  // Load events/profiles from nostr: links
  async function loadNostrLinks(content: string) {
    const links = parseNostrLinks(content);
    if (links.length === 0) return;

    const eventIds: string[] = [];
    const aTags: string[] = [];
    const npubs: string[] = [];

    for (const link of links) {
      try {
        if (link.type === 'nevent' || link.type === 'note1') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'nevent') {
            eventIds.push(decoded.data.id);
          } else if (decoded.type === 'note') {
            eventIds.push(decoded.data as string);
          }
        } else if (link.type === 'naddr') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'naddr') {
            const aTag = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
            aTags.push(aTag);
          }
        } else if (link.type === 'npub' || link.type === 'profile') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'npub') {
            npubs.push(link.value);
            nostrLinkProfiles.set(link.value, decoded.data as string);
          }
        }
      } catch {
        // Invalid nostr link, skip
      }
    }

    // Fetch events
    if (eventIds.length > 0) {
      try {
        const events = await Promise.race([
          nostrClient.fetchEvents([{ ids: eventIds, limit: eventIds.length }]),
          new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
        ]);
        
        for (const event of events) {
          nostrLinkEvents.set(event.id, event);
        }
      } catch {
        // Ignore fetch errors
      }
    }

    // Fetch a-tag events
    if (aTags.length > 0) {
      for (const aTag of aTags) {
        const parts = aTag.split(':');
        if (parts.length === 3) {
          try {
            const kind = parseInt(parts[0]);
            const pubkey = parts[1];
            const dTag = parts[2];
            const events = await Promise.race([
              nostrClient.fetchEvents([{ kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }]),
              new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
            ]);
            
            if (events.length > 0) {
              nostrLinkEvents.set(events[0].id, events[0]);
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }
    }
  }

  // Get event from nostr: link
  function getEventFromNostrLink(link: string): NostrEvent | undefined {
    try {
      if (link.startsWith('nostr:nevent1') || link.startsWith('nostr:note1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'nevent') {
          return nostrLinkEvents.get(decoded.data.id);
        } else if (decoded.type === 'note') {
          return nostrLinkEvents.get(decoded.data as string);
        }
      } else if (link.startsWith('nostr:naddr1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'naddr') {
          const eventId = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
          return Array.from(nostrLinkEvents.values()).find(e => {
            const dTag = e.tags.find(t => t[0] === 'd')?.[1];
            return e.kind === decoded.data.kind && 
                   e.pubkey === decoded.data.pubkey && 
                   dTag === decoded.data.identifier;
          });
        }
      }
    } catch {
      // Invalid link
    }
    return undefined;
  }

  // Get pubkey from nostr: npub/profile link
  function getPubkeyFromNostrLink(link: string): string | undefined {
    return nostrLinkProfiles.get(link);
  }

  // Process content with nostr links into parts for rendering
  function processContentWithNostrLinks(content: string): Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> {
    const links = parseNostrLinks(content);
    if (links.length === 0) {
      return [{ type: 'text', value: content }];
    }

    const parts: Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> = [];
    let lastIndex = 0;

    for (const link of links) {
      // Add text before link
      if (link.start > lastIndex) {
        const textPart = content.slice(lastIndex, link.start);
        if (textPart) {
          parts.push({ type: 'text', value: textPart });
        }
      }

      // Add link
      const event = getEventFromNostrLink(link.value);
      const pubkey = getPubkeyFromNostrLink(link.value);
      if (event) {
        parts.push({ type: 'event', value: link.value, event });
      } else if (pubkey) {
        parts.push({ type: 'profile', value: link.value, pubkey });
      } else {
        parts.push({ type: 'placeholder', value: link.value });
      }

      lastIndex = link.end;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      const textPart = content.slice(lastIndex);
      if (textPart) {
        parts.push({ type: 'text', value: textPart });
      }
    }

    return parts;
  }

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const gitDomain = $page.data.gitDomain || 'localhost:6543';

  // Sync viewer pubkey from store
  $effect(() => {
    const currentUser = $userStore;
    viewerPubkeyHex = currentUser.userPubkeyHex || null;
  });

  onMount(async () => {
    await loadUserProfile();
  });

  // Load messages when tab is active
  $effect(() => {
    if (activeTab === 'messages' && profileOwnerPubkeyHex && !messagesLoaded && !loadingMessages) {
      loadMessages();
    }
  });

  // Load activity when tab is active
  $effect(() => {
    if (activeTab === 'activity' && profileOwnerPubkeyHex && !activityLoaded && !loadingActivity) {
      loadActivity();
    }
  });

  async function loadUserProfile() {
    loading = true;
    error = null;

    try {
      // Decode npub
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        error = 'Invalid npub format';
        return;
      }
      profileOwnerPubkeyHex = decoded.data as string;

      // Load repositories
      const url = `/api/users/${npub}/repos?domain=${encodeURIComponent(gitDomain)}`;
      const response = await fetch(url, {
        headers: viewerPubkeyHex ? { 'X-User-Pubkey': viewerPubkeyHex } : {}
      });

      if (!response.ok) {
        throw new Error(`Failed to load repositories: ${response.statusText}`);
      }

      const data = await response.json();
      repos = data.repos || [];

      // Organize repos into owned, maintained, and favorites
      if (profileOwnerPubkeyHex) {
        await organizeRepos();
      }

      // Load profile
      profileEvent = await fetchUserProfile(profileOwnerPubkeyHex, DEFAULT_NOSTR_RELAYS);
      
      if (profileEvent) {
        // Parse JSON content
        try {
          if (profileEvent.content?.trim()) {
            profileData = JSON.parse(profileEvent.content);
          }
        } catch {
          profileData = null;
        }
        
        // Extract tags - only bot, nip05, and website, grouped by tag name
        const tagsToShow = new Set(['bot', 'nip05', 'website']);
        const groupedTags = new Map<string, string[]>();
        
        for (const tag of profileEvent.tags) {
          if (tag.length > 0 && tag[0] && tagsToShow.has(tag[0])) {
            const tagName = tag[0];
            const values: string[] = [];
            for (let i = 1; i < tag.length; i++) {
              if (tag[i]) {
                values.push(tag[i]);
              }
            }
            if (values.length > 0) {
              const existing = groupedTags.get(tagName) || [];
              groupedTags.set(tagName, [...existing, ...values]);
            }
          }
        }
        
        // Fallback to JSON content for missing tags (old-fashioned events)
        if (profileData && typeof profileData === 'object') {
          // Check for nip05
          if (!groupedTags.has('nip05') && profileData.nip05) {
            const nip05Values = Array.isArray(profileData.nip05) ? profileData.nip05 : [profileData.nip05];
            groupedTags.set('nip05', nip05Values.filter(Boolean).map(String));
          }
          
          // Check for website
          if (!groupedTags.has('website') && profileData.website) {
            const websiteValues = Array.isArray(profileData.website) ? profileData.website : [profileData.website];
            groupedTags.set('website', websiteValues.filter(Boolean).map(String));
          }
          
          // Check for bot
          if (!groupedTags.has('bot') && profileData.bot !== undefined) {
            const botValue = profileData.bot === true || profileData.bot === 'true' || profileData.bot === '1' ? 'true' : String(profileData.bot);
            groupedTags.set('bot', [botValue]);
          }
        }
        
        // Convert to array (nip05 verification happens asynchronously)
        profileTags = [];
        for (const [tagName, values] of groupedTags.entries()) {
          if (tagName === 'nip05') {
            // Initialize with unverified status, verify asynchronously
            profileTags.push({ name: tagName, values, verified: new Array(values.length).fill(false) });
          } else {
            profileTags.push({ name: tagName, values });
          }
        }
        
        // Verify nip05 values asynchronously
        verifyNip05Tags();

        // Extract profile fields (with fallback to JSON content)
        const nameTag = profileEvent.tags.find(t => t[0] === 'name' || t[0] === 'display_name')?.[1];
        const aboutTag = profileEvent.tags.find(t => t[0] === 'about')?.[1];
        const pictureTag = profileEvent.tags.find(t => t[0] === 'picture' || t[0] === 'avatar')?.[1];
        const bannerTag = profileEvent.tags.find(t => t[0] === 'banner')?.[1];

        userProfile = {
          name: nameTag || profileData?.display_name || profileData?.name,
          about: aboutTag || profileData?.about,
          picture: pictureTag || profileData?.picture,
          banner: bannerTag || profileData?.banner
        };
      }

      // Load payment targets (kind 10133)
      const paymentEvents = await nostrClient.fetchEvents([{
        kinds: [10133],
        authors: [profileOwnerPubkeyHex],
        limit: 1
      }]);

      const lightningAddresses = new Set<string>();
      
      // Extract from profile event (tags first, then JSON content fallback)
      if (profileEvent) {
        // Extract from tags
        const lud16Tags = profileEvent.tags.filter(t => t[0] === 'lud16').map(t => t[1]).filter(Boolean);
        lud16Tags.forEach(addr => lightningAddresses.add(addr.toLowerCase()));
        
        // Fallback to JSON content for lud16 (old-fashioned events)
        if (profileData?.lud16) {
          const lud16Values = Array.isArray(profileData.lud16) ? profileData.lud16 : [profileData.lud16];
          lud16Values.forEach((addr: any) => {
            if (addr) lightningAddresses.add(String(addr).toLowerCase());
          });
        }
      }

      // Extract from kind 10133
      if (paymentEvents.length > 0) {
        const paytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] === 'lightning' && t[2]);
        paytoTags.forEach(tag => {
          if (tag[2]) lightningAddresses.add(tag[2].toLowerCase());
        });
      }

      // Build payment targets
      const targets: Array<{ type: string; authority: string; payto: string }> = 
        Array.from(lightningAddresses).map(authority => ({
          type: 'lightning',
          authority,
          payto: `payto://lightning/${authority}`
        }));

      if (paymentEvents.length > 0) {
        const otherPaytoTags = paymentEvents[0].tags.filter(t => 
          t[0] === 'payto' && t[1] && t[1] !== 'lightning' && t[2]
        );
        otherPaytoTags.forEach(tag => {
          const type = tag[1]?.toLowerCase() || '';
          const authority = tag[2] || '';
          if (type && authority && !targets.find(p => p.type === type && p.authority.toLowerCase() === authority.toLowerCase())) {
            targets.push({ type, authority, payto: `payto://${type}/${authority}` });
          }
        });
      }

      paymentTargets = targets;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load user profile';
      console.error('Error loading user profile:', err);
    } finally {
      loading = false;
    }
  }

  async function verifyNip05Tags() {
    if (!profileOwnerPubkeyHex) return;
    
    // Find nip05 tags and verify them
    const updatedTags = [...profileTags];
    for (let i = 0; i < updatedTags.length; i++) {
      const tag = updatedTags[i];
      if (tag.name === 'nip05' && tag.verified) {
        const verified: boolean[] = [];
        for (const value of tag.values) {
          try {
            const { resolvePubkey } = await import('$lib/utils/pubkey-resolver.js');
            const resolvedPubkey = await resolvePubkey(value);
            verified.push(resolvedPubkey === profileOwnerPubkeyHex);
          } catch {
            verified.push(false);
          }
        }
        // Update the verified array
        updatedTags[i] = { ...tag, verified };
      }
    }
    // Update profileTags to trigger reactivity
    profileTags = updatedTags;
  }

  /**
   * Determines if an event should be excluded from the activity feed.
i   * 
   * @param event - The event to check
   * @param userPubkey - The pubkey of the user whose profile we're viewing
   * @param forActivityTab - If true, applies stricter filtering for activity tab (excludes ephemeral, replaceable, and metadata kinds)
   * @returns true if the event should be excluded
   */
  function shouldExcludeEvent(event: NostrEvent, userPubkey: string, forActivityTab: boolean = false): boolean {
    // Always exclude user's own events (events FROM the user)
    // Note: We want to SHOW events TO the user from other people, so we only exclude events FROM the user
    if (event.pubkey === userPubkey) {
      return true;
    }

    // When filtering for activity tab, apply stricter exclusions
    if (forActivityTab) {
      // Exclude all ephemeral events (20000-29999) - not meant to be stored
      if (isEphemeralKind(event.kind)) {
        return true;
      }

      // Exclude all replaceable events (0, 3, 10000-19999) - these are metadata/configuration
      if (isReplaceableKind(event.kind)) {
        return true;
      }

      // Exclude specific regular kinds that are not repo-related:
      
      // Kind 1: Keep this one in, just for the user's convenience

      // Kind 2: Client metadata (not relevant for activity)
      if (event.kind === 2) {
        return true;
      }
      
      // Kind 5: Deletion requests
      if (event.kind === KIND.DELETION_REQUEST) {
        return true;
      }
      
      // Kind 6: User's like to see reposts
      
      // Kind 7: User's like to see reactions

      // Kind 8: Badge awards (not relevant for repo activity)
      if (event.kind === 8) {
        return true;
      }
      
      // Kind 24: Public messages (shown in messages tab)
      if (event.kind === KIND.PUBLIC_MESSAGE) {
        return true;
      }
    }

    return false;
  }

  async function loadMessages() {
    if (!profileOwnerPubkeyHex || loadingMessages || messagesLoaded) return;
    
    loadingMessages = true;
    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      const allMessages = await messagesService.getAllMessagesForUser(profileOwnerPubkeyHex, 100);
      // Filter out user's own messages and write-proof events
      messages = allMessages.filter(msg => {
        // Convert PublicMessage to NostrEvent-like structure for filtering
        const eventLike: NostrEvent = {
          id: msg.id,
          pubkey: msg.pubkey,
          created_at: msg.created_at,
          kind: msg.kind,
          tags: msg.tags,
          content: msg.content,
          sig: msg.sig || ''
        };
        return !shouldExcludeEvent(eventLike, profileOwnerPubkeyHex || '');
      });
      
      // Fetch quoted events from q-tags
      await loadQuotedEvents(messages);
      
      // Fetch nostr: links from message content
      for (const message of messages) {
        await loadNostrLinks(message.content);
      }
    } catch (err) {
      console.error('Error loading messages:', err);
    } finally {
      messagesLoaded = true; // Mark as loaded to prevent infinite loop (even on error)
      loadingMessages = false;
    }
  }

  async function loadQuotedEvents(messages: PublicMessage[]) {
    // Collect all quoted event IDs from q-tags
    const quotedEventIds = new Set<string>();
    for (const message of messages) {
      const qTags = message.tags.filter(t => t[0] === 'q' && t[1]);
      for (const qTag of qTags) {
        if (qTag[1]) {
          quotedEventIds.add(qTag[1]);
        }
      }
    }

    if (quotedEventIds.size === 0) return;

    // Fetch events from relays (nostrClient will use cache internally)
    try {
      // Add timeout to prevent hanging
      const fetchPromise = nostrClient.fetchEvents([
        {
          ids: Array.from(quotedEventIds),
          limit: quotedEventIds.size
        }
      ]);
      
      const timeoutPromise = new Promise<NostrEvent[]>((resolve) => {
        setTimeout(() => resolve([]), 10000); // 10 second timeout
      });
      
      const fetchedEvents = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Update cache reactively - add new events, avoid duplicates
      const existingIds = new Set(quotedEvents.map(e => e.id));
      const newEvents = fetchedEvents.filter(e => !existingIds.has(e.id));
      if (newEvents.length > 0) {
        quotedEvents = [...quotedEvents, ...newEvents];
      }
    } catch (err) {
      console.warn('Failed to fetch quoted events:', err);
      // Don't leave loading state stuck - clear it on error
    }
  }

  async function sendMessage() {
    if (!newMessageContent.trim() || !viewerPubkeyHex || !profileOwnerPubkeyHex) {
      alert('Please enter a message and make sure you are logged in');
      return;
    }

    if (viewerPubkeyHex === profileOwnerPubkeyHex) {
      alert('You cannot send a message to yourself');
      return;
    }

    sendingMessage = true;
    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      
      const messageEvent = await messagesService.sendPublicMessage(
        viewerPubkeyHex,
        newMessageContent.trim(),
        [{ pubkey: profileOwnerPubkeyHex }]
      );

      const { outbox } = await getUserRelays(viewerPubkeyHex, nostrClient);
      const combinedRelays = combineRelays(outbox);
      const signedEvent = await signEventWithNIP07(messageEvent);
      const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish message to all relays');
      }

      messagesLoaded = false; // Reset flag to reload messages after sending
      await loadMessages();
      showSendMessageDialog = false;
      newMessageContent = '';
      alert('Message sent successfully!');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      sendingMessage = false;
    }
  }

  function getRepoName(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'name')?.[1] || 
           event.tags.find(t => t[0] === 'd')?.[1] || 
           'Unnamed';
  }

  function getRepoDescription(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'description')?.[1] || '';
  }

  async function organizeRepos() {
    if (!profileOwnerPubkeyHex) return;

    ownedRepos = [];
    maintainedRepos = [];
    favoriteRepos = [];

    const userPubkey = profileOwnerPubkeyHex; // Store in local variable for type safety
    if (!userPubkey) return;

    try {
      // Separate owned repos from the initial list
      ownedRepos = repos.filter(r => r.pubkey === userPubkey);

      // Load favorites (bookmarks kind 10003)
      const bookmarkEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.BOOKMARKS],
          authors: [userPubkey],
          limit: 100
        }
      ]);

      // Extract repo a-tags from bookmarks
      const favoriteATags = new Set<string>();
      for (const bookmark of bookmarkEvents) {
        for (const tag of bookmark.tags) {
          if (tag[0] === 'a' && tag[1]?.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)) {
            favoriteATags.add(tag[1]);
          }
        }
      }

      // Fetch repo announcements for bookmarked repos
      // Parse a-tags to get author and d-tag, then fetch specific repos
      if (favoriteATags.size > 0) {
        const favoriteRepoPromises: Promise<NostrEvent | null>[] = [];
        
        for (const aTag of favoriteATags) {
          // Parse a-tag format: "30617:pubkey:d-tag"
          const parts = aTag.split(':');
          if (parts.length >= 3 && parts[0] === String(KIND.REPO_ANNOUNCEMENT)) {
            const repoOwnerPubkey = parts[1];
            const repoId = parts[2];
            
            // Skip if this is the user's own repo (already in ownedRepos)
            if (repoOwnerPubkey.toLowerCase() === userPubkey.toLowerCase()) {
              continue;
            }
            
            // Fetch the specific repo announcement
            favoriteRepoPromises.push(
              nostrClient.fetchEvents([
                {
                  kinds: [KIND.REPO_ANNOUNCEMENT],
                  authors: [repoOwnerPubkey],
                  '#d': [repoId],
                  limit: 1
                }
              ]).then(events => events[0] || null)
            );
          }
        }
        
        const favoriteRepoResults = await Promise.all(favoriteRepoPromises);
        favoriteRepos = favoriteRepoResults.filter((repo): repo is NostrEvent => repo !== null);
      }

      // For maintained repos, we need to search through repos
      // This is less efficient, so we'll search recent repos and check maintainers
      // Limit to a reasonable number to avoid performance issues
      const recentRepoEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          limit: 200 // Search through recent repos
        }
      ]);

      // Filter for repos where user is a maintainer (but not owner)
      for (const repo of recentRepoEvents) {
        if (repo.pubkey.toLowerCase() === userPubkey.toLowerCase()) continue; // Skip owned repos
        
        const maintainersTag = repo.tags.find(t => t[0] === 'maintainers');
        if (maintainersTag) {
          const isMaintainer = maintainersTag.slice(1).some(m => {
            if (!m) return false;
            try {
              const decoded = nip19.decode(m);
              if (decoded.type === 'npub') {
                return (decoded.data as string).toLowerCase() === userPubkey.toLowerCase();
              }
            } catch {
              // Assume hex
            }
            return m.toLowerCase() === userPubkey.toLowerCase();
          });
          if (isMaintainer) {
            maintainedRepos.push(repo);
          }
        }
      }

      // Remove duplicates (a repo could be both maintained and favorited)
      maintainedRepos = maintainedRepos.filter((repo, index, self) => 
        index === self.findIndex(r => r.id === repo.id)
      );
      favoriteRepos = favoriteRepos.filter((repo, index, self) => 
        index === self.findIndex(r => r.id === repo.id) && 
        !maintainedRepos.find(m => m.id === repo.id) &&
        !ownedRepos.find(o => o.id === repo.id)
      );

    } catch (err) {
      console.error('Failed to organize repos:', err);
      // Fallback: just mark owned repos
      ownedRepos = repos.filter(r => r.pubkey === profileOwnerPubkeyHex);
    }
  }

  function getRepoId(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'd')?.[1] || '';
  }

  function getMessageRecipients(message: PublicMessage): string[] {
    return message.tags
      .filter(tag => tag[0] === 'p' && tag[1])
      .map(tag => tag[1]);
  }

  function formatMessageTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  async function loadActivity() {
    if (!profileOwnerPubkeyHex || loadingActivity || activityLoaded) return;

    const userPubkey = profileOwnerPubkeyHex; // Store in local variable for type safety
    loadingActivity = true;
    try {
      // Step 1: Fetch all repo announcements where user is owner or maintainer
      const repoAnnouncements = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [userPubkey],
          limit: 100
        }
      ]);

      // Step 2: Extract a-tags from repo announcements
      const aTags = new Set<string>();
      for (const announcement of repoAnnouncements) {
        const dTag = announcement.tags.find(t => t[0] === 'd')?.[1];
        if (dTag) {
          const aTag = `${KIND.REPO_ANNOUNCEMENT}:${announcement.pubkey}:${dTag}`;
          aTags.add(aTag);
        }
      }

      // Step 3: Also check for repos where user is a maintainer (not just owner)
      // We'll fetch announcements and check maintainer tags
      const allAnnouncements = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          '#p': [userPubkey], // Events that mention the user
          limit: 100
        }
      ]);

      for (const announcement of allAnnouncements) {
        // Check if user is in maintainers tag
        const maintainersTag = announcement.tags.find(t => t[0] === 'maintainers');
        if (maintainersTag) {
          const isMaintainer = maintainersTag.slice(1).some(m => {
            // Handle both hex and npub formats
            try {
              const decoded = nip19.decode(m);
              if (decoded.type === 'npub') {
                return (decoded.data as string).toLowerCase() === userPubkey.toLowerCase();
              }
            } catch {
              // Assume hex
            }
            return m.toLowerCase() === userPubkey.toLowerCase();
          });
          
          if (isMaintainer) {
            const dTag = announcement.tags.find(t => t[0] === 'd')?.[1];
            if (dTag) {
              const aTag = `${KIND.REPO_ANNOUNCEMENT}:${announcement.pubkey}:${dTag}`;
              aTags.add(aTag);
            }
          }
        }
      }

      // Step 4: Fetch events that reference the user or their repos
      const filters: any[] = [];

      // Events with user in p-tag
      filters.push({
        '#p': [userPubkey],
        limit: 200
      });

      // Events with user in q-tag
      filters.push({
        '#q': [userPubkey],
        limit: 200
      });

      // Events with repo a-tags
      if (aTags.size > 0) {
        filters.push({
          '#a': Array.from(aTags),
          limit: 200
        });
      }

      const allActivityEvents = await nostrClient.fetchEvents(filters);

      // Step 5: Deduplicate, filter, and sort by created_at (newest first)
      const eventMap = new Map<string, NostrEvent>();
      for (const event of allActivityEvents) {
        // Use shared exclusion function to filter out:
        // - User's own events
        // - Ephemeral events (20000-29999)
        // - Replaceable events (0, 3, 10000-19999) - metadata/configuration
        // - Non-repo regular kinds (1, 2, 5, 6, 7, 8, 24)
        if (shouldExcludeEvent(event, userPubkey, true)) {
          continue;
        }
        
        // Keep the newest version if duplicate
        const existing = eventMap.get(event.id);
        if (!existing || event.created_at > existing.created_at) {
          eventMap.set(event.id, event);
        }
      }

      // Sort by created_at descending and limit to 200
      activityEvents = Array.from(eventMap.values())
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 200);

      // Fetch referenced events from a-tags and e-tags
      await loadReferencedEvents(activityEvents);
      
      // Fetch nostr: links from event content
      for (const event of activityEvents) {
        if (event.content) {
          await loadNostrLinks(event.content);
        }
      }
    } catch (err) {
      console.error('Failed to load activity:', err);
      error = 'Failed to load activity';
    } finally {
      activityLoaded = true; // Mark as loaded to prevent infinite loop (even on error)
      loadingActivity = false;
    }
  }

  async function loadReferencedEvents(events: NostrEvent[]) {
    // Collect all referenced event IDs and a-tags
    const eventIds = new Set<string>();
    const aTags = new Set<string>();
    
    for (const event of events) {
      // Collect e-tags (event references)
      const eTags = event.tags.filter(t => t[0] === 'e' && t[1]);
      for (const eTag of eTags) {
        if (eTag[1]) {
          eventIds.add(eTag[1]);
        }
      }
      
      // Collect a-tags (addressable event references)
      const aTagValues = event.tags.filter(t => t[0] === 'a' && t[1]);
      for (const aTag of aTagValues) {
        if (aTag[1]) {
          aTags.add(aTag[1]);
        }
      }
    }

    if (eventIds.size === 0 && aTags.size === 0) return;

    // Fetch events by ID
    const eventsToFetch: Promise<NostrEvent[]>[] = [];
    
    if (eventIds.size > 0) {
      eventsToFetch.push(
        nostrClient.fetchEvents([
          {
            ids: Array.from(eventIds),
            limit: eventIds.size
          }
        ]).catch(() => [])
      );
    }

    // Fetch events by a-tags
    if (aTags.size > 0) {
      for (const aTag of aTags) {
        const parts = aTag.split(':');
        if (parts.length === 3) {
          const kind = parseInt(parts[0]);
          const pubkey = parts[1];
          const dTag = parts[2];
          
          eventsToFetch.push(
            nostrClient.fetchEvents([
              {
                kinds: [kind],
                authors: [pubkey],
                '#d': [dTag],
                limit: 1
              }
            ]).catch(() => [])
          );
        }
      }
    }

    // Fetch all referenced events
    try {
      const fetchPromises = eventsToFetch.map(p => 
        Promise.race([
          p,
          new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
        ])
      );
      
      const fetchedEventsArrays = await Promise.all(fetchPromises);
      const fetchedEvents = fetchedEventsArrays.flat();
      
      // Update cache reactively - add new events, avoid duplicates
      const existingIds = new Set(referencedEvents.map(e => e.id));
      const newEvents = fetchedEvents.filter(e => !existingIds.has(e.id));
      if (newEvents.length > 0) {
        referencedEvents = [...referencedEvents, ...newEvents];
      }
    } catch (err) {
      console.warn('Failed to fetch referenced events:', err);
    }
  }

  function getEventContext(event: NostrEvent): string {
    // Special handling for reaction events (kind 7)
    if (event.kind === 7) {
      const reaction = event.content?.trim() || '+';
      const eTag = event.tags.find(t => t[0] === 'e')?.[1];
      if (eTag) {
        return `Reacted ${reaction} to event ${eTag.slice(0, 8)}...`;
      }
      return `Reacted ${reaction}`;
    }

    // Extract context from event content or tags
    if (event.content && event.content.trim()) {
      // Limit to first 200 characters
      const content = event.content.trim();
      // Skip if it's just whitespace or very short
      if (content.length > 3) {
        if (content.length <= 200) {
          return content;
        }
        return content.substring(0, 197) + '...';
      }
    }

    // Try to get context from tags (in order of preference)
    const nameTag = event.tags.find(t => t[0] === 'name')?.[1];
    if (nameTag && nameTag.trim()) {
      return nameTag.trim();
    }

    const descriptionTag = event.tags.find(t => t[0] === 'description')?.[1];
    if (descriptionTag && descriptionTag.trim()) {
      const desc = descriptionTag.trim();
      return desc.length > 200 ? desc.substring(0, 197) + '...' : desc;
    }

    // Try summary tag
    const summaryTag = event.tags.find(t => t[0] === 'summary')?.[1];
    if (summaryTag && summaryTag.trim()) {
      return summaryTag.trim();
    }

    // Try title tag
    const titleTag = event.tags.find(t => t[0] === 'title')?.[1];
    if (titleTag && titleTag.trim()) {
      return titleTag.trim();
    }

    // Build context from kind and other tags
    const kindNames: Record<number, string> = {
      [KIND.PULL_REQUEST]: 'Pull Request',
      [KIND.ISSUE]: 'Issue',
      [KIND.COMMENT]: 'Comment',
      [KIND.PATCH]: 'Patch',
      [KIND.REPO_ANNOUNCEMENT]: 'Repository Announcement',
      [KIND.REPO_STATE]: 'Repository State',
      [KIND.PUBLIC_MESSAGE]: 'Public Message',
    };

    const kindName = kindNames[event.kind] || `Event kind ${event.kind}`;
    
    // Try to add repo context if available
    const aTag = event.tags.find(t => t[0] === 'a' && t[1]?.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`));
    if (aTag && aTag[1]) {
      const parts = aTag[1].split(':');
      if (parts.length >= 3) {
        const repoId = parts[2];
        return `${kindName} - ${repoId}`;
      }
    }

    // Always return something, even if it's just the kind name
    return kindName || `Event ${event.id.slice(0, 8)}...`;
  }

  function parseRepost(event: NostrEvent): NostrEvent | null {
    // Reposts (kind 6) contain the embedded event as JSON in the content field
    if (event.kind !== KIND.REPOST || !event.content) {
      return null;
    }

    try {
      const embeddedEvent = JSON.parse(event.content);
      // Validate it's a proper Nostr event structure
      if (embeddedEvent && typeof embeddedEvent === 'object' && 
          embeddedEvent.kind !== undefined && 
          embeddedEvent.pubkey && 
          embeddedEvent.id) {
        return embeddedEvent as NostrEvent;
      }
    } catch {
      // Invalid JSON, return null
    }

    return null;
  }

  function parseZapReceipt(event: NostrEvent): {
    amount: string;
    senderPubkey?: string;
    recipientPubkey?: string;
    eventId?: string;
    comment?: string;
  } {
    const pTag = event.tags.find(t => t[0] === 'p')?.[1]; // Recipient
    const PTag = event.tags.find(t => t[0] === 'P')?.[1]; // Sender
    const eTag = event.tags.find(t => t[0] === 'e')?.[1]; // Event being zapped
    const bolt11Tag = event.tags.find(t => t[0] === 'bolt11')?.[1];
    const descriptionTag = event.tags.find(t => t[0] === 'description')?.[1];

    // Parse amount from zap request in description tag (more reliable than bolt11)
    let amount = 'Zap';
    if (descriptionTag) {
      try {
        const zapRequest = JSON.parse(descriptionTag);
        const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount');
        if (amountTag && amountTag[1]) {
          const millisats = parseInt(amountTag[1]);
          const sats = Math.round(millisats / 1000);
          if (sats > 0) {
            amount = `${sats} sats`;
          }
        }
      } catch {
        // Invalid JSON, try parsing from bolt11 as fallback
        if (bolt11Tag) {
          // Extract amount from bolt11 (format: lnbc{amount}{unit})
          // This is a simplified parser - bolt11 format is complex
          const match = bolt11Tag.match(/lnbc(\d+)([munp])?/);
          if (match) {
            const num = parseInt(match[1]);
            const unit = match[2] || '';
            let sats = num;
            if (unit === 'm') sats = num / 1000;
            else if (unit === 'u') sats = num / 1000000;
            else if (unit === 'n') sats = num / 1000000000;
            else if (unit === 'p') sats = num / 1000000000000;
            if (sats > 0) {
              amount = `${Math.round(sats)} sats`;
            }
          }
        }
      }
    }

    // Parse comment from zap request in description tag
    let comment: string | undefined;
    if (descriptionTag) {
      try {
        const zapRequest = JSON.parse(descriptionTag);
        if (zapRequest.content && zapRequest.content.trim()) {
          comment = zapRequest.content.trim();
        }
      } catch {
        // Invalid JSON, ignore
      }
    }

    return {
      amount,
      senderPubkey: PTag,
      recipientPubkey: pTag,
      eventId: eTag,
      comment
    };
  }

  function startReply(event: NostrEvent) {
    if (!viewerPubkeyHex) {
      alert('Please connect your NIP-07 extension to reply');
      return;
    }
    replyingToEvent = event;
    replyContent = '';
    showReplyDialog = true;
  }

  async function sendReply() {
    if (!replyingToEvent || !replyContent.trim() || !viewerPubkeyHex || sendingReply) return;

    sendingReply = true;
    try {
      let eventTemplate: Omit<NostrEvent, 'sig' | 'id'>;
      let targetRelays: string[];

      if (replyingToEvent.kind === KIND.PUBLIC_MESSAGE) {
        // Kind 24 reply (NIP-24) - use q-tag, no e/p/a tags
        // Get relays from message recipients or use recipient's relays
        const recipients = replyingToEvent.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
        const relayHints = replyingToEvent.tags.filter(t => t[0] === 'p' && t[2]).map(t => t[2]).filter(Boolean);
        
        // Use relay hints from p tags if available, otherwise fetch recipient's relays
        if (relayHints.length > 0) {
          targetRelays = [...new Set(relayHints)];
        } else if (recipients.length > 0) {
          // Fetch relays from the first recipient (or use all recipients' relays)
          const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
          const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
          const fullRelayClient = new NostrClient(allSearchRelays);
          
          // Get relays from all recipients and combine
          const allRecipientRelays: string[] = [];
          for (const recipient of recipients) {
            const { outbox, inbox } = await getUserRelays(recipient, fullRelayClient);
            allRecipientRelays.push(...outbox, ...inbox);
          }
          
          targetRelays = combineRelays([...new Set(allRecipientRelays)], DEFAULT_NOSTR_RELAYS);
        } else {
          // Fallback to default relays
          const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
          const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
          const fullRelayClient = new NostrClient(allSearchRelays);
          const { outbox, inbox } = await getUserRelays(viewerPubkeyHex, fullRelayClient);
          targetRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
        }

        // Get relay hint from q-tag if available, otherwise use first target relay
        const qTag = replyingToEvent.tags.find(t => t[0] === 'q');
        const relayHint = qTag?.[2] || targetRelays[0] || '';

        eventTemplate = {
          kind: KIND.PUBLIC_MESSAGE,
          pubkey: viewerPubkeyHex,
          created_at: Math.floor(Date.now() / 1000),
          content: replyContent.trim(),
          tags: [
            ['q', replyingToEvent.id, relayHint, replyingToEvent.pubkey],
            // Add p tags for recipients (from the original message)
            ...recipients.map(p => ['p', p, relayHint])
          ]
        };
      } else if (replyingToEvent.kind === 1) {
        const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
        const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
        const fullRelayClient = new NostrClient(allSearchRelays);
        const { outbox, inbox } = await getUserRelays(viewerPubkeyHex, fullRelayClient);
        targetRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
        // Kind 1 reply (NIP-10)
        const rootETag = replyingToEvent.tags.find(t => t[0] === 'e' && t[3] === 'root');
        const replyETag = replyingToEvent.tags.find(t => t[0] === 'e' && t[3] === 'reply');
        
        // Determine root ID: use root tag if present, otherwise the event itself is the root
        const rootId = rootETag?.[1] || replyingToEvent.id;
        // Check if we're replying directly to the root (event has no reply tag)
        const isDirectReplyToRoot = !replyETag;
        
        // Get all p tags from the event being replied to
        const pTags = replyingToEvent.tags.filter(t => t[0] === 'p').map(t => t[1]);
        // Add the author of the event being replied to if not already present
        if (!pTags.includes(replyingToEvent.pubkey)) {
          pTags.push(replyingToEvent.pubkey);
        }

        const tags: string[][] = [
          ['e', rootId, '', 'root']
        ];
        
        // Only add reply marker if not replying directly to root (NIP-10: for top-level replies, only root marker)
        if (!isDirectReplyToRoot) {
          tags.push(['e', replyingToEvent.id, '', 'reply']);
        }
        
        tags.push(...pTags.map(p => ['p', p]));

        eventTemplate = {
          kind: 1,
          pubkey: viewerPubkeyHex,
          created_at: Math.floor(Date.now() / 1000),
          content: replyContent.trim(),
          tags
        };
      } else {
        // Kind 1111 reply (NIP-22)
        const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
        const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
        const fullRelayClient = new NostrClient(allSearchRelays);
        const { outbox, inbox } = await getUserRelays(viewerPubkeyHex, fullRelayClient);
        targetRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
        
        // Find root event info
        const rootETag = replyingToEvent.tags.find(t => t[0] === 'E');
        const rootKTag = replyingToEvent.tags.find(t => t[0] === 'K');
        const rootPTag = replyingToEvent.tags.find(t => t[0] === 'P');
        const rootATag = replyingToEvent.tags.find(t => t[0] === 'A');

        // Use the event being replied to as root if no root tags found
        const rootEventId = rootETag?.[1] || replyingToEvent.id;
        const rootEventKind = rootKTag ? parseInt(rootKTag[1]) : replyingToEvent.kind;
        const rootPubkey = rootPTag?.[1] || replyingToEvent.pubkey;
        const rootRelay = rootETag?.[2] || rootPTag?.[2] || '';

        const tags: string[][] = [
          ['E', rootEventId, rootRelay, rootPubkey],
          ['K', rootEventKind.toString()],
          ['P', rootPubkey, rootRelay]
        ];

        if (rootATag) {
          tags.push(['A', rootATag[1], rootATag[2] || '']);
        }

        // Parent is the event being replied to
        tags.push(
          ['e', replyingToEvent.id, rootRelay, replyingToEvent.pubkey],
          ['k', replyingToEvent.kind.toString()],
          ['p', replyingToEvent.pubkey, rootRelay]
        );

        eventTemplate = {
          kind: KIND.COMMENT,
          pubkey: viewerPubkeyHex,
          created_at: Math.floor(Date.now() / 1000),
          content: replyContent.trim(),
          tags
        };
      }

      const signedEvent = await signEventWithNIP07(eventTemplate);
      
      // Publish to relays
      await nostrClient.publishEvent(signedEvent, targetRelays);

      // Store the event kind before clearing
      const wasMessageReply = replyingToEvent.kind === KIND.PUBLIC_MESSAGE;
      
      showReplyDialog = false;
      replyingToEvent = null;
      replyContent = '';
      
      // Reload to show the new reply
      if (wasMessageReply) {
        // Reload messages if replying to a message
        messagesLoaded = false;
        await loadMessages();
      } else {
        // Reload activity for other event types
        activityLoaded = false;
        await loadActivity();
      }
    } catch (err) {
      console.error('Failed to send reply:', err);
      alert(`Failed to send reply: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sendingReply = false;
    }
  }

  function getEventLink(event: NostrEvent): string {
    // Create a link to view the event using nevent or naddr
    try {
      // Check if it's a parameterized replaceable event (has 'a' tag)
      const aTag = event.tags.find(t => t[0] === 'a');
      if (aTag && aTag[1]) {
        // Use naddr for parameterized replaceable events
        const naddr = nip19.naddrEncode({
          identifier: event.tags.find(t => t[0] === 'd')?.[1] || '',
          pubkey: event.pubkey,
          kind: event.kind
        });
        return `https://aitherboard.imwald.eu/event/${naddr}`;
      } else {
        // Use nevent for regular events
        const nevent = nip19.neventEncode({
          id: event.id,
          author: event.pubkey,
          kind: event.kind
        });
        return `https://aitherboard.imwald.eu/event/${nevent}`;
      }
    } catch (err) {
      console.error('Failed to encode event link:', err);
      // Fallback to event ID
      return `#${event.id.substring(0, 8)}`;
    }
  }

  async function copyPaytoAddress(payto: string) {
    try {
      await navigator.clipboard.writeText(payto);
      alert('Payment address copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  async function copyLightningAddress(authority: string) {
    try {
      await navigator.clipboard.writeText(authority);
      alert('Lightning address copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy lightning address:', err);
    }
  }

  const isOwnProfile = $derived(viewerPubkeyHex === profileOwnerPubkeyHex);

  // Sort payment targets with lightning first
  const sortedPaymentTargets = $derived.by(() => {
    return [...paymentTargets].sort((a, b) => {
      const aType = a.type.toLowerCase();
      const bType = b.type.toLowerCase();
      if (aType === 'lightning') return -1;
      if (bType === 'lightning') return 1;
      return aType.localeCompare(bType);
    });
  });

  // Display address without payto:// prefix
  function getDisplayAddress(payto: string): string {
    return payto.replace(/^payto:\/\//, '');
  }
</script>

<div class="profile-page">
  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading profile...</p>
    </div>
  {:else if error}
    <div class="error-state">
      <h2>Error</h2>
      <p>{error}</p>
    </div>
  {:else}
    <!-- Profile Header -->
    <header class="profile-header">
      <div class="profile-avatar-section">
        {#if userProfile?.picture}
          <img src={userProfile.picture} alt="Profile" class="profile-avatar" />
        {:else}
          <div class="profile-avatar-placeholder">
            {npub.slice(0, 2).toUpperCase()}
          </div>
        {/if}
      </div>
      
      <div class="profile-info">
        <h1 class="profile-name">{userProfile?.name || npub.slice(0, 16) + '...'}</h1>
        {#if userProfile?.about}
          <p class="profile-bio">{userProfile.about}</p>
        {/if}
        <div class="profile-meta">
          <code class="profile-npub">{npub}</code>
        </div>
      </div>

      {#if isOwnProfile}
        <div class="profile-actions">
          <a href="/dashboard" class="action-button">
            <img src="/icons/layout-dashboard.svg" alt="Dashboard" class="icon-themed" />
            Dashboard
          </a>
        </div>
      {/if}
    </header>

    <!-- Profile Tags -->
    {#if profileTags.length > 0}
      <section class="profile-tags-section">
        <h2>Profile Metadata</h2>
        <div class="profile-tags-grid">
          {#each profileTags as tag}
            <div class="profile-tag-item">
              <span class="tag-name">{tag.name}:</span>
              <div class="tag-values">
                {#each tag.values as value, index}
                  <div class="tag-value-item">
                    {#if tag.name === 'website'}
                      <a href={value} target="_blank" rel="noopener noreferrer">{value}</a>
                    {:else if tag.name === 'nip05'}
                      <span class="nip05-value">{value}</span>
                      {#if tag.verified && tag.verified[index]}
                        <img src="/icons/check-circle.svg" alt="Verified" class="verified-icon" />
                      {/if}
                    {:else}
                      {value}
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Payment Targets -->
    {#if paymentTargets.length > 0}
      <section class="payment-section">
        <h2>Payment Methods</h2>
        <div class="payment-grid">
          {#each sortedPaymentTargets as target}
            <div class="payment-card">
              <code class="payment-address">{getDisplayAddress(target.payto)}</code>
              <div class="payment-actions">
                {#if target.type === 'lightning'}
                  <button 
                    class="lightning-button" 
                    onclick={() => copyLightningAddress(target.authority)}
                    title="Copy lightning address"
                  >
                    <img src="/icons/lightning.svg" alt="Lightning" class="icon-themed" />
                  </button>
                {/if}
                <button 
                  class="copy-button" 
                  onclick={() => copyPaytoAddress(target.payto)}
                  title="Copy payto address"
                >
                  <img src="/icons/copy.svg" alt="Copy" class="icon-themed" />
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Tabs -->
    <div class="tabs-container">
      <div class="tabs">
        <button 
          class="tab" 
          class:active={activeTab === 'repos'}
          onclick={() => activeTab = 'repos'}
        >
          Repositories <span class="tab-count">({repos.length})</span>
        </button>
        <button 
          class="tab" 
          class:active={activeTab === 'messages'}
          onclick={() => activeTab = 'messages'}
        >
          Messages <span class="tab-count">({messages.length})</span>
        </button>
        <button 
          class="tab" 
          class:active={activeTab === 'activity'}
          onclick={() => activeTab = 'activity'}
        >
          Activity <span class="tab-count">({activityEvents.length})</span>
        </button>
      </div>
    </div>

    <!-- Tab Content -->
    <main class="tab-content">
      {#if activeTab === 'repos'}
        <section class="repos-section">
          {#if repos.length === 0}
            <div class="empty-state">
              <p>No repositories found</p>
            </div>
          {:else}
            <!-- Repositories I Own -->
            {#if ownedRepos.length > 0}
              <div class="repo-section-group">
                <h3 class="repo-section-title">Repositories I Own</h3>
                <div class="repo-grid">
                  {#each ownedRepos as event}
                    {@const repoId = getRepoId(event)}
                    <div 
                      class="repo-card" 
                      role="button"
                      tabindex="0"
                      onclick={() => goto(`/repos/${npub}/${repoId}`)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          goto(`/repos/${npub}/${repoId}`);
                        }
                      }}
                    >
                      <h3 class="repo-name">{getRepoName(event)}</h3>
                      {#if getRepoDescription(event)}
                        <p class="repo-description">{getRepoDescription(event)}</p>
                      {/if}
                      <div class="repo-footer">
                        <span class="repo-date">
                          {new Date(event.created_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Repositories I Maintain -->
            {#if maintainedRepos.length > 0}
              <div class="repo-section-group">
                <h3 class="repo-section-title">Repositories I Maintain</h3>
                <div class="repo-grid">
                  {#each maintainedRepos as event}
                    {@const repoId = getRepoId(event)}
                    <div 
                      class="repo-card" 
                      role="button"
                      tabindex="0"
                      onclick={() => goto(`/repos/${npub}/${repoId}`)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          goto(`/repos/${npub}/${repoId}`);
                        }
                      }}
                    >
                      <h3 class="repo-name">{getRepoName(event)}</h3>
                      {#if getRepoDescription(event)}
                        <p class="repo-description">{getRepoDescription(event)}</p>
                      {/if}
                      <div class="repo-footer">
                        <span class="repo-date">
                          {new Date(event.created_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Favorite Repositories -->
            {#if favoriteRepos.length > 0}
              <div class="repo-section-group">
                <h3 class="repo-section-title">Favorite Repositories</h3>
                <div class="repo-grid">
                  {#each favoriteRepos as event}
                    {@const repoId = getRepoId(event)}
                    <div 
                      class="repo-card" 
                      role="button"
                      tabindex="0"
                      onclick={() => goto(`/repos/${npub}/${repoId}`)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          goto(`/repos/${npub}/${repoId}`);
                        }
                      }}
                    >
                      <h3 class="repo-name">{getRepoName(event)}</h3>
                      {#if getRepoDescription(event)}
                        <p class="repo-description">{getRepoDescription(event)}</p>
                      {/if}
                      <div class="repo-footer">
                        <span class="repo-date">
                          {new Date(event.created_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        </section>
      {:else if activeTab === 'messages'}
        <section class="messages-section">
          <div class="messages-header">
            <h2>Public Messages</h2>
            {#if viewerPubkeyHex && !isOwnProfile}
              <button onclick={() => showSendMessageDialog = true} class="send-button">
                Send Message
              </button>
            {/if}
          </div>

          {#if loadingMessages}
            <div class="loading-state">
              <div class="spinner"></div>
              <p>Loading messages...</p>
            </div>
          {:else if messages.length === 0}
            <div class="empty-state">
              <p>No messages found</p>
            </div>
          {:else}
            <div class="messages-list">
              {#each messages as message}
                {@const isFromViewer = viewerPubkeyHex !== null && message.pubkey === viewerPubkeyHex}
                {@const isToViewer = viewerPubkeyHex !== null && getMessageRecipients(message).includes(viewerPubkeyHex)}
                {@const qTags = message.tags.filter(t => t[0] === 'q')}
                <div class="message-card" class:from-viewer={isFromViewer} class:to-viewer={isToViewer && !isFromViewer}>
                  {#if qTags.length > 0}
                    {#each qTags as qTag}
                      {@const quotedEventId = qTag[1]}
                      {@const relayHint = qTag[2] || ''}
                      {@const quotedEvent = getQuotedEvent(quotedEventId)}
                      {#if quotedEvent}
                        <div class="quoted-event">
                          <div class="quoted-event-header">
                            <UserBadge pubkey={quotedEvent.pubkey} disableLink={true} />
                            <span class="quoted-event-time">{formatMessageTime(quotedEvent.created_at)}</span>
                          </div>
                          <div class="quoted-event-content">{quotedEvent.content || '(No content)'}</div>
                        </div>
                      {:else if quotedEventId}
                        <!-- Quoted event is being loaded or not found -->
                        <div class="quoted-event quoted-event-loading">
                          <div class="quoted-event-content">Quoted event {quotedEventId.slice(0, 8)}...</div>
                        </div>
                      {/if}
                    {/each}
                  {/if}
                  <div class="message-header">
                    <div class="message-participants">
                      <span class="participants-label">From:</span>
                      <UserBadge pubkey={message.pubkey} />
                      {#if getMessageRecipients(message).length > 0}
                        <span class="participants-label">To:</span>
                        {#each getMessageRecipients(message) as recipientPubkey}
                          <UserBadge pubkey={recipientPubkey} />
                        {/each}
                      {/if}
                    </div>
                    <div class="message-header-right">
                      <span class="message-time">{formatMessageTime(message.created_at)}</span>
                      <div class="message-actions">
                        {#if viewerPubkeyHex}
                          <button
                            onclick={() => startReply(message)}
                            class="message-action-button"
                            title="Reply"
                            aria-label="Reply"
                          >
                            <img src="/icons/message-circle.svg" alt="Reply" class="message-icon" />
                          </button>
                        {/if}
                        <a 
                          href={getEventLink(message)} 
                          class="message-action-button"
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View Event"
                          aria-label="View Event"
                        >
                          <img src="/icons/external-link.svg" alt="View" class="message-icon" />
                        </a>
                      </div>
                    </div>
                  </div>
                  <div class="message-body">
                    {#if true}
                      {@const parts = processContentWithNostrLinks(message.content)}
                      {#each parts as part}
                      {#if part.type === 'text'}
                        <span>{part.value}</span>
                      {:else if part.type === 'event' && part.event}
                        <div class="nostr-link-event">
                          <div class="nostr-link-event-header">
                            <UserBadge pubkey={part.event.pubkey} disableLink={true} />
                            <span class="nostr-link-event-time">{formatMessageTime(part.event.created_at)}</span>
                          </div>
                          <div class="nostr-link-event-content">{part.event.content || getEventContext(part.event)}</div>
                        </div>
                      {:else if part.type === 'profile' && part.pubkey}
                        <UserBadge pubkey={part.pubkey} />
                      {:else}
                        <span class="nostr-link-placeholder">{part.value}</span>
                      {/if}
                      {/each}
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeTab === 'activity'}
        <section class="activity-section">
          <div class="activity-header">
            <h2>Activity</h2>
          </div>

          {#if loadingActivity}
            <div class="loading-state">
              <div class="spinner"></div>
              <p>Loading activity...</p>
            </div>
          {:else if activityEvents.length === 0}
            <div class="empty-state">
              <p>No activity found</p>
            </div>
          {:else}
            <div class="activity-list">
              {#each activityEvents as event}
                <div class="activity-card" class:reaction-event={event.kind === 7} class:zap-receipt={event.kind === KIND.ZAP_RECEIPT}>
                  <div class="activity-context">
                    {#if event.kind === 7}
                      {@const reaction = event.content?.trim() || '+'}
                      {@const eTag = event.tags.find(t => t[0] === 'e')?.[1]}
                      <div class="reaction-display">
                        <span class="reaction-emoji">{reaction}</span>
                        <span class="reaction-text">
                          {eTag ? `Reacted to event ${eTag.slice(0, 8)}...` : 'Reacted'}
                        </span>
                      </div>
                    {:else if event.kind === KIND.ZAP_RECEIPT}
                      {@const zapData = parseZapReceipt(event)}
                      <div class="zap-display">
                        <div class="zap-icon" aria-label="Lightning Zap"></div>
                        <div class="zap-info">
                          <div class="zap-amount">{zapData.amount}</div>
                          <div class="zap-details">
                            {#if zapData.senderPubkey}
                              <span>From <UserBadge pubkey={zapData.senderPubkey} disableLink={true} /></span>
                            {/if}
                            {#if zapData.recipientPubkey && zapData.recipientPubkey !== profileOwnerPubkeyHex}
                              <span>To <UserBadge pubkey={zapData.recipientPubkey} disableLink={true} /></span>
                            {/if}
                            {#if zapData.eventId}
                              <span>on event {zapData.eventId.slice(0, 8)}...</span>
                            {/if}
                            {#if zapData.comment}
                              <div class="zap-comment">{zapData.comment}</div>
                            {/if}
                          </div>
                        </div>
                      </div>
                    {:else if event.kind === KIND.REPOST}
                      {@const embeddedEvent = parseRepost(event)}
                      {#if embeddedEvent}
                        <div class="repost-display">
                          <div class="repost-header">
                            <span class="repost-label">Reposted</span>
                          </div>
                          <div class="repost-content">
                            <div class="repost-author">
                              <UserBadge pubkey={embeddedEvent.pubkey} disableLink={true} />
                              <span class="repost-time">{formatMessageTime(embeddedEvent.created_at)}</span>
                            </div>
                            <div class="repost-text">{embeddedEvent.content || '(No content)'}</div>
                          </div>
                        </div>
                      {:else}
                        {@const content = getEventContext(event)}
                        {@const parts = processContentWithNostrLinks(content)}
                        <div class="activity-blurb">
                          {#each parts as part}
                            {#if part.type === 'text'}
                              <span>{part.value}</span>
                            {:else if part.type === 'event' && part.event}
                              <div class="nostr-link-event">
                                <div class="nostr-link-event-header">
                                  <UserBadge pubkey={part.event.pubkey} disableLink={true} />
                                  <span class="nostr-link-event-time">{formatMessageTime(part.event.created_at)}</span>
                                </div>
                                <div class="nostr-link-event-content">{part.event.content || getEventContext(part.event)}</div>
                              </div>
                            {:else if part.type === 'profile' && part.pubkey}
                              <UserBadge pubkey={part.pubkey} />
                            {:else}
                              <span class="nostr-link-placeholder">{part.value}</span>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                    {:else}
                      {@const eTag = event.tags.find(t => t[0] === 'e' && t[1])?.[1]}
                      {@const aTag = event.tags.find(t => t[0] === 'a' && t[1])?.[1]}
                      {@const referencedEvent = getReferencedEvent(eTag, aTag)}
                      {#if referencedEvent}
                        <div class="referenced-event">
                          <div class="referenced-event-header">
                            <UserBadge pubkey={referencedEvent.pubkey} disableLink={true} />
                            <span class="referenced-event-time">{formatMessageTime(referencedEvent.created_at)}</span>
                          </div>
                          <div class="referenced-event-content">{referencedEvent.content || getEventContext(referencedEvent)}</div>
                        </div>
                      {:else}
                        {@const content = getEventContext(event)}
                        {@const parts = processContentWithNostrLinks(content)}
                        <div class="activity-blurb">
                          {#each parts as part}
                            {#if part.type === 'text'}
                              <span>{part.value}</span>
                            {:else if part.type === 'event' && part.event}
                              <div class="nostr-link-event">
                                <div class="nostr-link-event-header">
                                  <UserBadge pubkey={part.event.pubkey} disableLink={true} />
                                  <span class="nostr-link-event-time">{formatMessageTime(part.event.created_at)}</span>
                                </div>
                                <div class="nostr-link-event-content">{part.event.content || getEventContext(part.event)}</div>
                              </div>
                            {:else if part.type === 'profile' && part.pubkey}
                              <UserBadge pubkey={part.pubkey} />
                            {:else}
                              <span class="nostr-link-placeholder">{part.value}</span>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                    {/if}
                  </div>
                  <div class="activity-footer">
                    <div class="activity-author">
                      <UserBadge pubkey={event.pubkey} />
                      <span class="activity-time">{formatMessageTime(event.created_at)}</span>
                    </div>
                    <div class="activity-actions">
                      {#if viewerPubkeyHex}
                        <button
                          onclick={() => startReply(event)}
                          class="activity-action-button"
                          title="Reply"
                          aria-label="Reply"
                        >
                          <img src="/icons/message-circle.svg" alt="Reply" class="activity-icon" />
                        </button>
                      {/if}
                      <a 
                        href={getEventLink(event)} 
                        class="activity-action-button"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="View Event"
                        aria-label="View Event"
                      >
                        <img src="/icons/external-link.svg" alt="View" class="activity-icon" />
                      </a>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </main>
  {/if}
</div>

<!-- Send Message Dialog -->
{#if showSendMessageDialog}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Send message"
    onclick={() => showSendMessageDialog = false}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showSendMessageDialog = false;
      }
    }}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
      <h3>Send Public Message</h3>
      <p class="modal-note">This message can be found and read on relays, but is not usuaally displayed in the main feeds.</p>
      <label>
        <textarea 
          bind:value={newMessageContent} 
          rows="6" 
          placeholder="Type your message..."
          disabled={sendingMessage}
          class="message-input"
        ></textarea>
      </label>
      <div class="modal-actions">
        <button 
          onclick={() => { showSendMessageDialog = false; newMessageContent = ''; }} 
          class="button-secondary"
          disabled={sendingMessage}
        >
          Cancel
        </button>
        <button 
          onclick={sendMessage} 
          disabled={!newMessageContent.trim() || sendingMessage} 
          class="button-primary"
        >
          {sendingMessage ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Reply Dialog -->
{#if showReplyDialog && replyingToEvent}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Reply"
    onclick={() => { showReplyDialog = false; replyingToEvent = null; replyContent = ''; }}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showReplyDialog = false;
        replyingToEvent = null;
        replyContent = '';
      }
    }}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
      <h3>Reply</h3>
      <p class="modal-note">
        {replyingToEvent.kind === 1 
          ? 'Replying to a text note (kind 1)' 
          : replyingToEvent.kind === KIND.PUBLIC_MESSAGE
          ? 'Replying to a public message (kind 24)'
          : `Replying with a comment (kind ${KIND.COMMENT})`}
      </p>
      <label>
        <textarea 
          bind:value={replyContent} 
          rows="6" 
          placeholder="Type your reply..."
          disabled={sendingReply}
          class="message-input"
        ></textarea>
      </label>
      <div class="modal-actions">
        <button 
          onclick={() => { showReplyDialog = false; replyingToEvent = null; replyContent = ''; }} 
          class="button-secondary"
          disabled={sendingReply}
        >
          Cancel
        </button>
        <button 
          onclick={sendReply} 
          disabled={!replyContent.trim() || sendingReply} 
          class="button-primary"
        >
          {sendingReply ? 'Sending...' : 'Send Reply'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .profile-page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  /* Loading & Error States */
  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    text-align: center;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border-color);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state h2 {
    color: var(--text-primary);
    margin-bottom: 0.5rem;
  }

  /* Profile Header */
  .profile-header {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 2rem;
    align-items: start;
    padding: 2rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 1rem;
    margin-bottom: 2rem;
  }

  .profile-avatar-section {
    position: relative;
  }

  .profile-avatar {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--border-color);
  }

  .profile-avatar-placeholder {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3rem;
    font-weight: bold;
    border: 3px solid var(--border-color);
  }

  .profile-info {
    flex: 1;
  }

  .profile-name {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .profile-bio {
    font-size: 1.1rem;
    color: var(--text-secondary);
    margin: 0.5rem 0 1rem 0;
    line-height: 1.6;
  }

  .profile-meta {
    margin-top: 1rem;
  }

  .profile-npub {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-muted);
    background: var(--bg-secondary);
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    display: inline-block;
  }

  .profile-actions {
    display: flex;
    gap: 0.75rem;
  }

  .action-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    text-decoration: none;
    border-radius: 0.5rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .action-button:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .action-button .icon-themed {
    width: 18px;
    height: 18px;
  }

  /* Payment Section */
  .payment-section {
    margin-bottom: 2rem;
    padding: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 1rem;
  }

  /* Profile Tags */
  .profile-tags-section {
    margin: 2rem 0;
  }

  .profile-tags-section h2 {
    margin: 0 0 1.5rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .profile-tags-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  .profile-tag-item {
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .tag-name {
    font-weight: 600;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .tag-values {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .tag-value-item {
    color: var(--text-primary);
    word-break: break-word;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tag-value-item a {
    color: var(--accent);
    text-decoration: none;
  }

  .tag-value-item a:hover {
    text-decoration: underline;
  }

  .nip05-value {
    color: var(--text-primary);
  }

  .verified-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    opacity: 0.8;
    filter: brightness(0) saturate(100%) invert(1); /* Default white for dark themes */
  }

  /* Light theme: green check icon */
  :global([data-theme="light"]) .verified-icon {
    filter: brightness(0) saturate(100%) invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
  }

  /* Dark themes: green check icon */
  :global([data-theme="dark"]) .verified-icon,
  :global([data-theme="black"]) .verified-icon {
    filter: brightness(0) saturate(100%) invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
  }

  .payment-section h2 {
    margin: 0 0 1.5rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .payment-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .payment-card {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    position: relative;
  }

  .payment-address {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-secondary);
    word-break: break-all;
    flex: 1;
    min-width: 0;
    padding-right: 0.5rem;
  }

  .payment-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-shrink: 0;
  }

  .copy-button,
  .lightning-button {
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    padding: 0.25rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .copy-button:hover,
  .lightning-button:hover {
    background: var(--bg-tertiary);
    border-color: var(--accent);
  }

  .copy-button img,
  .lightning-button img {
    width: 14px;
    height: 14px;
  }

  /* Icon Theming */
  .icon-themed {
    display: block;
    filter: brightness(0) saturate(100%) invert(1) !important; /* Default white for dark themes */
    opacity: 1 !important;
  }

  /* Light theme: black icon */
  :global([data-theme="light"]) .icon-themed {
    filter: brightness(0) saturate(100%) !important; /* Black in light theme */
    opacity: 1 !important;
  }

  /* Dark themes: white icon */
  :global([data-theme="dark"]) .icon-themed,
  :global([data-theme="black"]) .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White in dark themes */
    opacity: 1 !important;
  }

  /* Hover states - icons in buttons should stay visible */
  .action-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  :global([data-theme="light"]) .action-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  .copy-button:hover .icon-themed,
  .lightning-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  :global([data-theme="light"]) .copy-button:hover .icon-themed,
  :global([data-theme="light"]) .lightning-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  /* Tabs */
  .tabs-container {
    margin-bottom: 2rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 2px solid var(--border-color);
  }

  .tab {
    padding: 1rem 1.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    transition: all 0.2s ease;
    position: relative;
    top: 2px;
  }

  .tab:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  .tab-count {
    opacity: 0.7;
    font-weight: normal;
  }

  /* Repositories */
  .repo-section-group {
    margin-bottom: 3rem;
  }

  .repo-section-group:last-child {
    margin-bottom: 0;
  }

  .repo-section-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 1rem 0;
  }

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .repo-card {
    padding: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .repo-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .repo-name {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .repo-description {
    color: var(--text-secondary);
    margin: 0.5rem 0;
    line-height: 1.5;
  }

  .repo-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color);
  }

  .repo-date {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  /* Messages */
  .messages-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .messages-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .send-button {
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 0.5rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .send-button:hover {
    opacity: 0.9;
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .message-card {
    padding: 1.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.75rem;
  }

  /* Light theme: even lighter background for better contrast */
  :global([data-theme="light"]) .message-card {
    background: #f5f5f5;
  }

  /* Dark theme: darker background for better contrast */
  :global([data-theme="dark"]) .message-card {
    background: rgba(0, 0, 0, 0.3);
  }

  /* Black theme: gray background (not purple) */
  :global([data-theme="black"]) .message-card {
    background: #1a1a1a;
  }

  .message-card.from-viewer {
    border-color: var(--accent);
  }

  /* Light theme: very subtle muted purple background for viewer messages */
  :global([data-theme="light"]) .message-card.from-viewer {
    background: rgba(138, 43, 226, 0.06);
  }

  /* Dark theme: subtle muted purple background for viewer messages */
  :global([data-theme="dark"]) .message-card.from-viewer {
    background: rgba(138, 43, 226, 0.08);
  }

  /* Black theme: slightly lighter gray with subtle accent border (not purple) */
  :global([data-theme="black"]) .message-card.from-viewer {
    background: #252525;
    border-color: var(--accent);
  }

  .message-card.to-viewer {
    border-left: 4px solid var(--accent);
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .message-participants {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex: 1;
  }

  .participants-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .message-time {
    font-size: 0.875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .message-body {
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
  }

  .message-header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .message-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .message-action-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.2s ease;
    text-decoration: none;
    color: var(--text-primary);
  }

  .message-action-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .message-icon {
    width: 1.25rem;
    height: 1.25rem;
    filter: var(--icon-filter, none);
  }

  .quoted-event {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-left: 3px solid var(--border-color);
    border-radius: 0.5rem;
    font-size: 0.875rem;
  }

  :global([data-theme="light"]) .quoted-event {
    background: #e8e8e8;
  }

  :global([data-theme="dark"]) .quoted-event {
    background: rgba(0, 0, 0, 0.2);
  }

  :global([data-theme="black"]) .quoted-event {
    background: #0a0a0a;
  }

  .quoted-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .quoted-event-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .quoted-event-content {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
    max-height: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .quoted-event-loading {
    opacity: 0.6;
    font-style: italic;
  }

  /* Activity */
  .activity-section {
    padding: 0;
  }

  .activity-header {
    margin-bottom: 1.5rem;
  }

  .activity-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .activity-card {
    padding: 1.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.75rem;
    transition: all 0.2s ease;
  }

  .activity-card:hover {
    border-color: var(--accent);
  }

  :global([data-theme="light"]) .activity-card {
    background: #f5f5f5;
  }

  :global([data-theme="dark"]) .activity-card {
    background: rgba(0, 0, 0, 0.3);
  }

  :global([data-theme="black"]) .activity-card {
    background: #1a1a1a;
  }

  .activity-context {
    margin-bottom: 1rem;
  }

  .activity-blurb {
    color: var(--text-primary);
    line-height: 1.6;
    margin: 0;
    word-wrap: break-word;
    min-height: 1.5rem;
    display: block;
  }
  
  .activity-blurb:empty::before {
    content: '(No content)';
    color: var(--text-muted);
    font-style: italic;
  }

  .reaction-display {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .reaction-emoji {
    font-size: 2rem;
    line-height: 1;
    display: inline-block;
  }

  .reaction-text {
    color: var(--text-primary);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  .reaction-event {
    border-left: 3px solid var(--accent);
  }

  .zap-display {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }

  .zap-icon {
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    /* Make lightning icon prominent with accent-colored glow */
    filter: drop-shadow(0 0 8px var(--accent)) drop-shadow(0 0 4px var(--accent)) drop-shadow(0 0 2px var(--accent));
  }

  /* Use CSS mask to colorize the icon with accent color */
  .zap-icon {
    mask-image: url('/icons/lightning.svg');
    mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
    background-color: var(--accent);
    -webkit-mask-image: url('/icons/lightning.svg');
    -webkit-mask-size: contain;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
  }

  .zap-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .zap-amount {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--accent);
  }

  .zap-details {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-primary);
    line-height: 1.5;
  }

  .zap-details span {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .zap-comment {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-radius: 0.5rem;
    border-left: 2px solid var(--accent);
    font-style: italic;
    color: var(--text-secondary);
  }

  .zap-receipt {
    border-left: 3px solid var(--accent);
    background: var(--bg-secondary);
  }

  .zap-receipt .zap-icon {
    filter: drop-shadow(0 0 4px var(--accent));
  }

  .repost-display {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .repost-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .repost-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .repost-content {
    padding: 1rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    border-left: 3px solid var(--accent);
  }

  .repost-author {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .repost-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .repost-text {
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
  }

  .referenced-event {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-primary);
    border-left: 3px solid var(--border-color);
    border-radius: 0.5rem;
    font-size: 0.875rem;
  }

  :global([data-theme="light"]) .referenced-event {
    background: #e8e8e8;
  }

  :global([data-theme="dark"]) .referenced-event {
    background: rgba(0, 0, 0, 0.2);
  }

  :global([data-theme="black"]) .referenced-event {
    background: #0a0a0a;
  }

  .referenced-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .referenced-event-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .referenced-event-content {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
    max-height: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nostr-link-event {
    margin: 0.75rem 0;
    padding: 0.75rem;
    background: var(--bg-primary);
    border-left: 3px solid var(--border-color);
    border-radius: 0.5rem;
    font-size: 0.875rem;
  }

  :global([data-theme="light"]) .nostr-link-event {
    background: #e8e8e8;
  }

  :global([data-theme="dark"]) .nostr-link-event {
    background: rgba(0, 0, 0, 0.2);
  }

  :global([data-theme="black"]) .nostr-link-event {
    background: #0a0a0a;
  }

  .nostr-link-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .nostr-link-event-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .nostr-link-event-content {
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
    max-height: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nostr-link-placeholder {
    color: var(--text-muted);
    font-style: italic;
  }

  .activity-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .activity-author {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
  }

  .activity-time {
    font-size: 0.875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .activity-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .activity-action-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.2s ease;
    text-decoration: none;
    color: var(--text-primary);
  }

  .activity-action-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .activity-icon {
    width: 1.25rem;
    height: 1.25rem;
    filter: var(--icon-filter, none);
  }

  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 3rem;
    color: var(--text-secondary);
  }

  /* Modal */
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
    padding: 1rem;
  }

  .modal {
    background: var(--card-bg);
    border-radius: 1rem;
    padding: 2rem;
    max-width: 500px;
    width: 100%;
    border: 1px solid var(--border-color);
  }

  .modal h3 {
    margin: 0 0 1rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .modal-note {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-radius: 0.5rem;
  }

  .message-input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    font-family: inherit;
    font-size: 1rem;
    resize: vertical;
    box-sizing: border-box;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .message-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .modal-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }

  .button-primary,
  .button-secondary {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 0.5rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .button-primary {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .button-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .button-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .button-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
  }

  .button-secondary:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  /* Responsive */
  @media (max-width: 768px) {
    .profile-page {
      padding: 1rem;
    }

    .profile-header {
      grid-template-columns: 1fr;
      text-align: center;
    }

    .profile-avatar-section {
      justify-self: center;
    }

    .repo-grid {
      grid-template-columns: 1fr;
    }

    .payment-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
