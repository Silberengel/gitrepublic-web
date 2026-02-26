/**
 * User profile utilities
 * Handles fetching and caching user email/name
 */

import { nip19 } from 'nostr-tools';
import { settingsStore } from '$lib/services/settings-store.js';
import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';

interface CachedUserData {
  email: string | null;
  name: string | null;
}

interface FetchingFlags {
  email: boolean;
  name: boolean;
}

/**
 * Get user email with caching
 */
export async function getUserEmail(
  userPubkeyHex: string | null,
  userPubkey: string | null,
  cachedData: CachedUserData,
  fetchingFlags: FetchingFlags
): Promise<string> {
  // Check settings store first
  try {
    const settings = await settingsStore.getSettings();
    if (settings.userEmail && settings.userEmail.trim()) {
      cachedData.email = settings.userEmail.trim();
      return cachedData.email;
    }
  } catch (err) {
    console.warn('Failed to get userEmail from settings:', err);
  }

  // Return cached email if available
  if (cachedData.email) {
    return cachedData.email;
  }

  // If no user pubkey, can't proceed
  if (!userPubkeyHex) {
    throw new Error('User not authenticated');
  }

  // Prevent concurrent fetches
  if (fetchingFlags.email) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (cachedData.email) {
      return cachedData.email;
    }
  }

  fetchingFlags.email = true;
  let prefillEmail: string;
  
  try {
    prefillEmail = await fetchUserEmail(userPubkeyHex, userPubkey || undefined, DEFAULT_NOSTR_RELAYS);
  } catch (err) {
    console.warn('Failed to fetch user profile for email:', err);
    const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
    const shortenedNpub = npubFromPubkey.substring(0, 20);
    prefillEmail = `${shortenedNpub}@gitrepublic.web`;
  } finally {
    fetchingFlags.email = false;
  }
  
  // Prompt user for email address
  const userEmail = prompt(
    'Please enter your email address for git commits.\n\n' +
    'This will be used as the author email in your commits.\n' +
    'You can use any email address you prefer.',
    prefillEmail
  );

  if (userEmail && userEmail.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(userEmail.trim())) {
      cachedData.email = userEmail.trim();
      settingsStore.setSetting('userEmail', cachedData.email).catch(console.error);
      return cachedData.email;
    } else {
      alert('Invalid email format. Using fallback email address.');
    }
  }

  cachedData.email = prefillEmail;
  return cachedData.email;
}

/**
 * Get user name with caching
 */
export async function getUserName(
  userPubkeyHex: string | null,
  userPubkey: string | null,
  cachedData: CachedUserData,
  fetchingFlags: FetchingFlags
): Promise<string> {
  // Check settings store first
  try {
    const settings = await settingsStore.getSettings();
    if (settings.userName && settings.userName.trim()) {
      cachedData.name = settings.userName.trim();
      return cachedData.name;
    }
  } catch (err) {
    console.warn('Failed to getUserName from settings:', err);
  }

  // Return cached name if available
  if (cachedData.name) {
    return cachedData.name;
  }

  // If no user pubkey, can't proceed
  if (!userPubkeyHex) {
    throw new Error('User not authenticated');
  }

  // Prevent concurrent fetches
  if (fetchingFlags.name) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (cachedData.name) {
      return cachedData.name;
    }
  }

  fetchingFlags.name = true;
  let prefillName: string;
  
  try {
    prefillName = await fetchUserName(userPubkeyHex, userPubkey || undefined, DEFAULT_NOSTR_RELAYS);
  } catch (err) {
    console.warn('Failed to fetch user profile for name:', err);
    const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
    const shortenedNpub = npubFromPubkey.substring(0, 20);
    prefillName = shortenedNpub;
  } finally {
    fetchingFlags.name = false;
  }
  
  // Prompt user for name
  const userName = prompt(
    'Please enter your name for git commits.\n\n' +
    'This will be used as the author name in your commits.\n' +
    'You can use any name you prefer.',
    prefillName
  );

  if (userName && userName.trim()) {
    cachedData.name = userName.trim();
    settingsStore.setSetting('userName', cachedData.name).catch(console.error);
    return cachedData.name;
  }

  cachedData.name = prefillName;
  return cachedData.name;
}
