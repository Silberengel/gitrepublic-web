/**
 * Utility for checking admin access
 * Admin is determined by ADMIN_NPUB environment variable
 */

import { nip19 } from 'nostr-tools';

/**
 * Get admin npub from environment variable
 * Defaults to the npub set in docker-compose.yml if not explicitly set
 */
function getAdminNpub(): string | null {
  if (typeof process === 'undefined') return null;
  const adminNpub = process.env?.ADMIN_NPUB;
  
  // If not set, use the default from docker-compose.yml
  if (!adminNpub || adminNpub.trim().length === 0) {
    const defaultAdminNpub = 'npub12umrfdjgvdxt45g0y3ghwcyfagssjrv5qlm3t6pu2aa5vydwdmwq8q0z04';
    console.log('[admin-check] ADMIN_NPUB not set, using default:', defaultAdminNpub);
    return defaultAdminNpub;
  }
  
  return adminNpub.trim();
}

/**
 * Get admin pubkey hex from environment variable
 */
function getAdminPubkeyHex(): string | null {
  const adminNpub = getAdminNpub();
  if (!adminNpub) {
    if (typeof process !== 'undefined') {
      console.log('[admin-check] No ADMIN_NPUB environment variable set');
    }
    return null;
  }
  
  try {
    const decoded = nip19.decode(adminNpub);
    if (decoded.type === 'npub') {
      const hex = decoded.data as string;
      if (typeof process !== 'undefined') {
        console.log('[admin-check] Admin npub decoded to hex:', hex.substring(0, 16) + '...');
      }
      return hex;
    }
  } catch (err) {
    // Invalid npub format
    if (typeof process !== 'undefined') {
      console.warn('[admin-check] Failed to decode admin npub:', err);
    }
  }
  
  return null;
}

/**
 * Check if a user is an admin
 * @param userPubkey - The user's pubkey in hex format or npub format
 * @returns true if the user is an admin
 */
export function isAdmin(userPubkey: string | null): boolean {
  if (!userPubkey) return false;
  
  const adminPubkeyHex = getAdminPubkeyHex();
  if (!adminPubkeyHex) return false;
  
  // Convert user pubkey to hex if it's an npub
  let userPubkeyHex: string | null = null;
  
  // Check if it's already hex format
  if (/^[0-9a-f]{64}$/i.test(userPubkey)) {
    userPubkeyHex = userPubkey.toLowerCase();
  } else {
    // Try to decode as npub
    try {
      const decoded = nip19.decode(userPubkey);
      if (decoded.type === 'npub') {
        userPubkeyHex = (decoded.data as string).toLowerCase();
      }
    } catch {
      // Invalid format
      return false;
    }
  }
  
  if (!userPubkeyHex) return false;
  
  const isAdminUser = userPubkeyHex === adminPubkeyHex.toLowerCase();
  
  if (typeof process !== 'undefined') {
    console.log('[admin-check] Checking admin status:');
    console.log('[admin-check] User pubkey hex:', userPubkeyHex);
    console.log('[admin-check] Admin pubkey hex:', adminPubkeyHex.toLowerCase());
    console.log('[admin-check] Match:', isAdminUser);
  }
  
  return isAdminUser;
}

/**
 * Check if admin is configured
 */
export function isAdminConfigured(): boolean {
  return getAdminNpub() !== null;
}
