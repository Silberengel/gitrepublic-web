<script lang="ts">
  import { nip19 } from 'nostr-tools';

  export let eventId: string;
  export let kind: number | undefined = undefined;
  export let pubkey: string | undefined = undefined;

  // Utility function to encode event to nevent or naddr
  function encodeEvent(eventId: string, kind?: number, pubkey?: string): string {
    try {
      // For parameterized replaceable events (kinds 30000-39999), use naddr
      if (kind && kind >= 30000 && kind < 40000 && pubkey) {
        // Extract identifier from event (for repo announcements, it's the repo name)
        // For now, we'll use nevent for all events, but this can be extended
        return nip19.neventEncode({
          id: eventId,
          ...(pubkey ? { author: pubkey } : {})
        });
      }
      // For all other events, use nevent
      return nip19.neventEncode({
        id: eventId,
        ...(pubkey ? { author: pubkey } : {})
      });
    } catch (err) {
      console.error('Error encoding event:', err);
      return eventId; // Fallback to raw event ID
    }
  }

  // Copy event address to clipboard
  async function copyEventAddress() {
    try {
      const encoded = encodeEvent(eventId, kind, pubkey);
      await navigator.clipboard.writeText(encoded);
      // Show a brief success message (you could use a toast library here)
      alert('Copied to clipboard: ' + encoded);
    } catch (err) {
      console.error('Error copying to clipboard:', err);
      alert('Failed to copy to clipboard');
    }
  }
</script>

<div class="event-copy-container">
  {#if kind !== undefined}
    <span class="kind-label">kind {kind}</span>
  {/if}
  <button 
    class="btn-icon"
    onclick={copyEventAddress}
    title="Copy event address"
  >
    <img src="/icons/copy.svg" alt="Copy" class="icon-inline" />
  </button>
</div>

<style>
  .event-copy-container {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .kind-label {
    font-size: 0.75rem;
    color: var(--text-secondary, #666);
    opacity: 0.7;
    font-weight: normal;
  }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .btn-icon:hover {
    opacity: 1;
  }

  .btn-icon:active {
    opacity: 0.5;
  }

  .btn-icon .icon-inline {
    width: 16px;
    height: 16px;
    margin: 0;
    display: block;
  }
</style>
