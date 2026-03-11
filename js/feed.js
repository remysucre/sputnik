// Fetch and aggregate feeds from other users' sites

import * as crypto from './crypto.js';

const DEFAULT_BASE = 'satellite';

// Resolve which repo a user's data lives in, then fetch their profile.
// Checks satellite.json at the root first (in case the user has a custom
// repo name or an unrelated project called "satellite"), then falls back
// to the default /satellite/ path.
async function resolve(domain) {
  const redirect = await fetch(`https://${domain}/satellite.json`);
  if (redirect.ok) {
    const data = await redirect.json();
    if (data.sat_repo) {
      const real = await fetch(`https://${domain}/${data.sat_repo}/satproto.json`);
      if (real.ok) {
        return { profile: await real.json(), repo: data.sat_repo };
      }
    }
  }
  const fallback = await fetch(`https://${domain}/${DEFAULT_BASE}/satproto.json`);
  if (fallback.ok) {
    return { profile: await fallback.json(), repo: DEFAULT_BASE };
  }
  throw new Error(`Profile not found for ${domain}`);
}

export async function fetchProfile(domain) {
  const { profile } = await resolve(domain);
  return profile;
}

// Get the base URL for a user's sat data (e.g. "https://alice.com/satellite/sat")
async function getSatRoot(domain) {
  const { profile, repo } = await resolve(domain);
  return { base: `https://${domain}/${repo}/sat`, profile };
}

export async function fetchFollowList(domain) {
  const { base } = await getSatRoot(domain);
  const resp = await fetch(`${base}/follows/index.json`);
  if (!resp.ok) throw new Error(`Follow list not found for ${domain}`);
  return resp.json();
}

export async function fetchPostIndex(domain) {
  const { base } = await getSatRoot(domain);
  const resp = await fetch(`${base}/posts/index.json`);
  if (!resp.ok) throw new Error(`Post index not found for ${domain}`);
  return resp.json();
}

async function fetchKeyEnvelope(satBase, myDomain, mySecret) {
  const resp = await fetch(`${satBase}/keys/${myDomain}.json`);
  if (!resp.ok) throw new Error(`No key envelope for ${myDomain}`);
  const envelope = await resp.json();
  const sealed = crypto.fromBase64(envelope.encrypted_key);
  return crypto.openContentKey(sealed, mySecret);
}

async function fetchPost(satBase, postId, contentKey) {
  const resp = await fetch(`${satBase}/posts/${postId}.json.enc`);
  if (!resp.ok) throw new Error(`Post ${postId} not found`);
  const encrypted = new Uint8Array(await resp.arrayBuffer());
  const decrypted = crypto.decryptData(encrypted, contentKey);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function fetchUserPosts(domain, myDomain, mySecret, limit = 50) {
  const { base } = await getSatRoot(domain);
  const contentKey = await fetchKeyEnvelope(base, myDomain, mySecret);
  const resp = await fetch(`${base}/posts/index.json`);
  if (!resp.ok) throw new Error(`Post index not found for ${domain}`);
  const index = await resp.json();
  const posts = [];
  for (const postId of index.posts.slice(0, limit)) {
    try {
      posts.push(await fetchPost(base, postId, contentKey));
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
