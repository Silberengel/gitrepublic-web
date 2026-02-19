<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';

  const dispatch = createEventDispatcher();

  type TransferData = {
    eventId: string;
    fromPubkey: string;
    toPubkey: string;
    repoTag: string;
    repoName: string;
    originalOwner: string;
    timestamp: number;
    createdAt: string;
    event: NostrEvent;
  };

  let { transfer }: { transfer: TransferData } = $props();

  let closing = $state(false);

  function handleCompleteTransfer() {
    // Parse repo info from repoTag (kind:pubkey:repo)
    const currentTransfer = transfer;
    const parts = currentTransfer.repoTag.split(':');
    if (parts.length < 3) {
      alert('Invalid repository tag format');
      return;
    }

    const originalOwnerPubkey = parts[1];
    const repoName = parts[2];
    
    // Convert original owner pubkey to npub
    let originalOwnerNpub: string;
    try {
      originalOwnerNpub = nip19.npubEncode(originalOwnerPubkey);
    } catch {
      alert('Invalid owner pubkey format');
      return;
    }

    // Navigate to signup page with transfer data
    const params = new URLSearchParams({
      transfer: 'true',
      transferEventId: currentTransfer.eventId,
      originalOwner: originalOwnerNpub,
      repo: repoName,
      repoTag: currentTransfer.repoTag
    });

    goto(`/signup?${params.toString()}`);
  }

  function handleDismiss() {
    closing = true;
    const currentTransfer = transfer;
    dispatch('dismiss', { eventId: currentTransfer.eventId });
    setTimeout(() => {
      // Component will be removed by parent
    }, 300);
  }

  // Format timestamp
  const formattedDate = $derived(new Date(transfer.createdAt).toLocaleDateString());
</script>

<div class="transfer-notification" class:closing>
  <div class="notification-content">
    <div class="notification-header">
      <h3>Repository Ownership Transfer</h3>
      <button class="close-button" onclick={handleDismiss} aria-label="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="notification-body">
      <p>
        You have been named as the new owner of the repository: <strong>{transfer.repoName}</strong>
      </p>
      <p class="notification-details">
        Transfer initiated on {formattedDate}
      </p>
      <p class="notification-instruction">
        Please complete the transfer by publishing a new repo announcement.
      </p>
    </div>
    <div class="notification-actions">
      <button class="button-primary" onclick={handleCompleteTransfer}>
        Complete Transfer
      </button>
      <button class="button-secondary" onclick={handleDismiss}>
        Dismiss
      </button>
    </div>
  </div>
</div>

<style>
  .transfer-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 1000;
    max-width: 500px;
    background: var(--bg-primary, #fff);
    border: 2px solid var(--border-color, #ddd);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: slideIn 0.3s ease-out;
    transition: opacity 0.3s ease-out, transform 0.3s ease-out;
  }

  .transfer-notification.closing {
    opacity: 0;
    transform: translateX(100%);
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .notification-content {
    padding: 20px;
  }

  .notification-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .notification-header h3 {
    margin: 0;
    font-size: 1.2em;
    color: var(--text-primary, #333);
  }

  .close-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: var(--text-secondary, #666);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background-color 0.2s;
  }

  .close-button:hover {
    background-color: var(--bg-secondary, #f0f0f0);
  }

  .notification-body {
    margin-bottom: 16px;
  }

  .notification-body p {
    margin: 8px 0;
    color: var(--text-primary, #333);
    line-height: 1.5;
  }

  .notification-details {
    font-size: 0.9em;
    color: var(--text-secondary, #666);
  }

  .notification-instruction {
    font-weight: 500;
    color: var(--text-primary, #333);
  }

  .notification-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
  }

  .button-primary,
  .button-secondary {
    padding: 10px 20px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1em;
    font-weight: 500;
    transition: background-color 0.2s, transform 0.1s;
  }

  .button-primary {
    background-color: var(--primary-color, #007bff);
    color: white;
  }

  .button-primary:hover {
    background-color: var(--primary-hover, #0056b3);
    transform: translateY(-1px);
  }

  .button-secondary {
    background-color: var(--bg-secondary, #f0f0f0);
    color: var(--text-primary, #333);
  }

  .button-secondary:hover {
    background-color: var(--bg-tertiary, #e0e0e0);
  }

  @media (max-width: 600px) {
    .transfer-notification {
      top: 10px;
      right: 10px;
      left: 10px;
      max-width: none;
    }
  }
</style>
