/**
 * Service for handling NIP-24 public messages (kind 24)
 * Public messages are direct messages that can be seen by anyone
 */

import { NostrClient } from './nostr-client.js';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import { getUserRelays } from './user-relays.js';
import { combineRelays } from '../../config.js';
import logger from '../logger.js';
import { verifyEvent } from 'nostr-tools';

export interface PublicMessage extends NostrEvent {
  kind: typeof KIND.PUBLIC_MESSAGE;
}

export class PublicMessagesService {
  private nostrClient: NostrClient;

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Fetch public messages sent to a user (where user is in p tags)
   */
  async getMessagesToUser(
    userPubkey: string,
    limit: number = 50
  ): Promise<PublicMessage[]> {
    try {
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.PUBLIC_MESSAGE],
          '#p': [userPubkey], // Messages where user is a recipient
          limit
        }
      ]);

      // Verify events and filter to only valid kind 24
      const validMessages = events
        .filter((e): e is PublicMessage => {
          if (e.kind !== KIND.PUBLIC_MESSAGE) return false;
          if (!verifyEvent(e)) {
            logger.warn({ eventId: e.id.slice(0, 16) + '...' }, 'Invalid signature in public message');
            return false;
          }
          return true;
        })
        .sort((a, b) => b.created_at - a.created_at); // Newest first

      return validMessages;
    } catch (error) {
      logger.error({ error, userPubkey: userPubkey.slice(0, 16) + '...' }, 'Failed to fetch public messages to user');
      throw error;
    }
  }

  /**
   * Fetch public messages sent by a user
   */
  async getMessagesFromUser(
    userPubkey: string,
    limit: number = 50
  ): Promise<PublicMessage[]> {
    try {
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.PUBLIC_MESSAGE],
          authors: [userPubkey],
          limit
        }
      ]);

      // Verify events
      const validMessages = events
        .filter((e): e is PublicMessage => {
          if (e.kind !== KIND.PUBLIC_MESSAGE) return false;
          if (!verifyEvent(e)) {
            logger.warn({ eventId: e.id.slice(0, 16) + '...' }, 'Invalid signature in public message');
            return false;
          }
          return true;
        })
        .sort((a, b) => b.created_at - a.created_at); // Newest first

      return validMessages;
    } catch (error) {
      logger.error({ error, userPubkey: userPubkey.slice(0, 16) + '...' }, 'Failed to fetch public messages from user');
      throw error;
    }
  }

  /**
   * Fetch all public messages involving a user (sent to or from)
   */
  async getAllMessagesForUser(
    userPubkey: string,
    limit: number = 50
  ): Promise<PublicMessage[]> {
    try {
      const [toUser, fromUser] = await Promise.all([
        this.getMessagesToUser(userPubkey, limit),
        this.getMessagesFromUser(userPubkey, limit)
      ]);

      // Combine and deduplicate by event ID
      const messageMap = new Map<string, PublicMessage>();
      [...toUser, ...fromUser].forEach(msg => {
        messageMap.set(msg.id, msg);
      });

      // Sort by created_at descending
      return Array.from(messageMap.values())
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
    } catch (error) {
      logger.error({ error, userPubkey: userPubkey.slice(0, 16) + '...' }, 'Failed to fetch all public messages for user');
      throw error;
    }
  }

  /**
   * Create and publish a public message
   * Messages are sent to inbox relays of recipients and outbox relay of sender
   */
  async sendPublicMessage(
    senderPubkey: string,
    content: string,
    recipients: Array<{ pubkey: string; relay?: string }>,
    senderRelays?: string[]
  ): Promise<PublicMessage> {
    if (!content.trim()) {
      throw new Error('Message content cannot be empty');
    }

    if (recipients.length === 0) {
      throw new Error('At least one recipient is required');
    }

    // Build p tags for recipients
    const pTags: string[][] = recipients.map(recipient => {
      const tag: string[] = ['p', recipient.pubkey];
      if (recipient.relay) {
        tag.push(recipient.relay);
      }
      return tag;
    });

    // Create the event (will be signed by client)
    const messageEvent: Omit<PublicMessage, 'id' | 'sig'> = {
      pubkey: senderPubkey,
      kind: KIND.PUBLIC_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: pTags,
      content: content.trim()
    };

    // Get sender's outbox relays if not provided
    let outboxRelays: string[] = senderRelays || [];
    if (outboxRelays.length === 0) {
      const { outbox } = await getUserRelays(senderPubkey, this.nostrClient);
      outboxRelays = outbox;
    }

    // Get inbox relays for each recipient
    const recipientInboxes = new Set<string>();
    for (const recipient of recipients) {
      if (recipient.relay) {
        recipientInboxes.add(recipient.relay);
      } else {
        // Fetch recipient's inbox relays
        try {
          const { inbox } = await getUserRelays(recipient.pubkey, this.nostrClient);
          inbox.forEach(relay => recipientInboxes.add(relay));
        } catch (error) {
          logger.warn({ error, recipient: recipient.pubkey.slice(0, 16) + '...' }, 'Failed to fetch recipient inbox relays');
        }
      }
    }

    // Combine all relays: sender's outbox + all recipient inboxes
    const allRelays = combineRelays([...outboxRelays, ...Array.from(recipientInboxes)]);

    // Return the event (client will sign and publish)
    return messageEvent as PublicMessage;
  }

  /**
   * Get recipients from a public message
   */
  getRecipients(message: PublicMessage): Array<{ pubkey: string; relay?: string }> {
    return message.tags
      .filter(tag => tag[0] === 'p' && tag[1])
      .map(tag => ({
        pubkey: tag[1],
        relay: tag[2] || undefined
      }));
  }

  /**
   * Check if a message is sent to a specific user
   */
  isMessageToUser(message: PublicMessage, userPubkey: string): boolean {
    return message.tags.some(tag => tag[0] === 'p' && tag[1] === userPubkey);
  }

  /**
   * Check if a message is from a specific user
   */
  isMessageFromUser(message: PublicMessage, userPubkey: string): boolean {
    return message.pubkey === userPubkey;
  }
}
