// Fetch and aggregate feeds from other users' sites

import * as crypto from './crypto.js';


export async function fetchProfile(domain) {
  const resp = await fetch(`https://${domain}/satproto.json`);
  if (!resp.ok) throw new Error(`Profile not found for ${domain}`);
  return resp.json();
}

export async function fetchFollowList(domain) {
  const resp = await fetch(`https://${domain}/sat/follows/index.json`);
  if (!resp.ok) throw new Error(`Follow list not found for ${domain}`);
  return resp.json();
}

export async function fetchPostIndex(domain) {
  const resp = await fetch(`https://${domain}/sat/posts/index.json`);
  if (!resp.ok) throw new Error(`Post index not found for ${domain}`);
  return resp.json();
}

async function fetchKeyEnvelope(domain, myDomain, mySecret) {
  const resp = await fetch(`https://${domain}/sat/keys/${myDomain}.json`);
  if (!resp.ok) throw new Error(`No key envelope from ${domain} for ${myDomain}`);
  const envelope = await resp.json();
  const sealed = crypto.fromBase64(envelope.encrypted_key);
  return crypto.openContentKey(sealed, mySecret);
}

async function fetchPost(domain, postId, contentKey) {
  const resp = await fetch(`https://${domain}/sat/posts/${postId}.json.enc`);
  if (!resp.ok) throw new Error(`Post ${postId} not found on ${domain}`);
  const encrypted = new Uint8Array(await resp.arrayBuffer());
  const decrypted = crypto.decryptData(encrypted, contentKey);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function fetchUserPosts(domain, myDomain, mySecret, limit = 50) {
  const contentKey = await fetchKeyEnvelope(domain, myDomain, mySecret);
  const index = await fetchPostIndex(domain);
  const posts = [];
  for (const postId of index.posts.slice(0, limit)) {
    try {
      posts.push(await fetchPost(domain, postId, contentKey));
    } catch (e) {
      console.warn(`Failed to fetch post ${postId} from ${domain}:`, e);
    }
  }
  return posts;
}

export function mergeFeed(postArrays) {
  return postArrays.flat().sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
}

export function filterReplies(posts, postId, postAuthor) {
  return posts.filter(
    (p) => p.reply_to === postId && p.reply_to_author === postAuthor
  );
}
