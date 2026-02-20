/**
 * User store for managing user state and access level across the application
 * Persists to localStorage for persistent login across page refreshes
 */

import { writable } from 'svelte/store';
import type { UserLevel } from '../services/nostr/user-level-service.js';
import { isSessionExpired, clearActivity } from '../services/activity-tracker.js';

export interface UserState {
  userPubkey: string | null;
  userPubkeyHex: string | null;
  userLevel: UserLevel;
  checkingLevel: boolean;
  error: string | null;
}

const STORAGE_KEY = 'gitrepublic_user_state';

const initialState: UserState = {
  userPubkey: null,
  userPubkeyHex: null,
  userLevel: 'strictly_rate_limited',
  checkingLevel: false,
  error: null
};

/**
 * Load user state from localStorage
 */
function loadFromStorage(): UserState | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    
    const parsed = JSON.parse(stored) as UserState;
    
    // Validate that we have required fields
    if (!parsed.userPubkey || !parsed.userPubkeyHex) {
      return null;
    }
    
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save user state to localStorage
 */
function saveToStorage(state: UserState): void {
  if (typeof window === 'undefined') return;
  
  try {
    // Only save if user is logged in
    if (state.userPubkey && state.userPubkeyHex) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      // Clear storage if user is logged out
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (err) {
    console.error('Failed to save user state to localStorage:', err);
  }
}

/**
 * Initialize state from localStorage or use initial state
 */
function getInitialState(): UserState {
  // Check if session has expired (24 hours of inactivity)
  if (isSessionExpired()) {
    // Session expired - clear storage and return initial state
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      clearActivity();
    }
    return initialState;
  }
  
  // Try to load from storage
  const stored = loadFromStorage();
  if (stored) {
    return stored;
  }
  
  return initialState;
}

function createUserStore() {
  const { subscribe, set, update } = writable<UserState>(getInitialState());

  return {
    subscribe,
    set: (newState: UserState) => {
      set(newState);
      saveToStorage(newState);
    },
    update: (updater: (state: UserState) => UserState) => {
      update(state => {
        const newState = updater(state);
        saveToStorage(newState);
        return newState;
      });
    },
    reset: () => {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
        clearActivity();
      }
      set(initialState);
    },
    setChecking: (checking: boolean) => {
      update(state => {
        const newState = { ...state, checkingLevel: checking };
        saveToStorage(newState);
        return newState;
      });
    },
    setUser: (
      userPubkey: string | null,
      userPubkeyHex: string | null,
      userLevel: UserLevel,
      error: string | null = null
    ) => {
      update(state => {
        const newState = {
          ...state,
          userPubkey,
          userPubkeyHex,
          userLevel,
          checkingLevel: false,
          error
        };
        saveToStorage(newState);
        return newState;
      });
    }
  };
}

export const userStore = createUserStore();
