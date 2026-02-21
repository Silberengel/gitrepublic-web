/**
 * API endpoint for fetching user profile with payment targets
 * Returns full profile event (kind 0) and payment targets (kind 10133)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { fetchUserProfile } from '$lib/utils/user-profile.js';
import type { NostrEvent } from '$lib/types/nostr.js';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async (event) => {
  try {
    const { npub } = event.params;
    if (!npub) {
      return handleValidationError('Missing npub parameter', { operation: 'getUserProfile' });
    }
    
    // Decode npub to get pubkey
    let userPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        return handleValidationError('Invalid npub format', { operation: 'getUserProfile', npub });
      }
      userPubkey = decoded.data as string;
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getUserProfile', npub });
    }
    
    // Fetch user profile (kind 0) - check cache first
    const profileEvent = await fetchUserProfile(userPubkey, DEFAULT_NOSTR_RELAYS);
    
    // Extract profile data - prefer tags, fallback to JSON
    let profileData: any = {};
    if (profileEvent) {
      try {
        profileData = JSON.parse(profileEvent.content);
      } catch {
        // Invalid JSON, will use tags
      }
    }
    
    // Extract from tags (new format) - prefer tags over JSON
    const nameTag = profileEvent?.tags.find(t => t[0] === 'name' || t[0] === 'display_name')?.[1];
    const aboutTag = profileEvent?.tags.find(t => t[0] === 'about')?.[1];
    const pictureTag = profileEvent?.tags.find(t => t[0] === 'picture' || t[0] === 'avatar')?.[1];
    const websiteTags = profileEvent?.tags.filter(t => t[0] === 'website' || t[0] === 'w').map(t => t[1]).filter(Boolean) || [];
    const nip05Tags = profileEvent?.tags.filter(t => t[0] === 'nip05' || t[0] === 'l').map(t => t[1]).filter(Boolean) || [];
    
    // Initialize lightning addresses set for collecting from multiple sources
    const lightningAddresses = new Set<string>();
    
    // Extract lightning addresses from NIP-01 (lud16 tag or JSON)
    if (profileEvent) {
      // From tags (lud16)
      const lud16Tags = profileEvent.tags.filter(t => t[0] === 'lud16').map(t => t[1]).filter(Boolean);
      lud16Tags.forEach(addr => lightningAddresses.add(addr.toLowerCase()));
      
      // From JSON (lud16 field)
      if (profileData.lud16 && typeof profileData.lud16 === 'string') {
        lightningAddresses.add(profileData.lud16.toLowerCase());
      }
    }
    
    // Fetch kind 10133 (payment targets)
    const paymentEvents = await nostrClient.fetchEvents([
      {
        kinds: [10133],
        authors: [userPubkey],
        limit: 1
      }
    ]);
    
    // Extract lightning addresses from kind 10133
    if (paymentEvents.length > 0) {
      const paytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] === 'lightning' && t[2]);
      paytoTags.forEach(tag => {
        if (tag[2]) {
          lightningAddresses.add(tag[2].toLowerCase());
        }
      });
    }
    
    // Build payment targets array - start with lightning addresses
    const paymentTargets: Array<{ type: string; authority: string; payto: string }> = Array.from(lightningAddresses).map(authority => ({
      type: 'lightning',
      authority,
      payto: `payto://lightning/${authority}`
    }));
    
    // Also include other payment types from kind 10133
    if (paymentEvents.length > 0) {
      const otherPaytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] && t[1] !== 'lightning' && t[2]);
      otherPaytoTags.forEach(tag => {
        const type = tag[1]?.toLowerCase() || '';
        const authority = tag[2] || '';
        if (type && authority) {
          // Check if we already have this (for deduplication)
          const existing = paymentTargets.find(p => p.type === type && p.authority.toLowerCase() === authority.toLowerCase());
          if (!existing) {
            paymentTargets.push({
              type,
              authority,
              payto: `payto://${type}/${authority}`
            });
          }
        }
      });
    }
    
    return json({
      npub,
      pubkey: userPubkey,
      profile: {
        name: nameTag || profileData.display_name || profileData.name,
        about: aboutTag || profileData.about,
        picture: pictureTag || profileData.picture,
        websites: websiteTags,
        nip05: nip05Tags
      },
      profileEvent: profileEvent ? {
        id: profileEvent.id,
        pubkey: profileEvent.pubkey,
        created_at: profileEvent.created_at,
        kind: profileEvent.kind,
        tags: profileEvent.tags,
        content: profileEvent.content,
        sig: profileEvent.sig
      } : null,
      paymentTargets,
      paymentEvent: paymentEvents.length > 0 ? {
        id: paymentEvents[0].id,
        pubkey: paymentEvents[0].pubkey,
        created_at: paymentEvents[0].created_at,
        kind: paymentEvents[0].kind,
        tags: paymentEvents[0].tags,
        content: paymentEvents[0].content,
        sig: paymentEvents[0].sig
      } : null
    });
  } catch (err) {
    return handleApiError(err, { operation: 'getUserProfile' }, 'Failed to get user profile');
  }
};
