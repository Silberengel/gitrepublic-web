/**
 * Page metadata and OpenGraph tags for homepage
 */

import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url }) => {
  const gitDomain = url.host || 'localhost:6543';
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const baseUrl = `${protocol}://${gitDomain}`;

  return {
    title: 'GitRepublic - Decentralized Git Hosting on Nostr',
    description: 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.',
    image: `${baseUrl}/logo.png`,
    url: baseUrl,
    ogType: 'website'
  };
};
