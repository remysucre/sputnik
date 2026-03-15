// Main application logic

import * as crypto from './crypto.js';
import * as github from './github.js';
import * as feed from './feed.js';

const DEFAULT_FEED_LIMIT = 50;

// --- Helpers ---

function getDomain() {
  return window.location.hostname;
}

function getRepoName() {
  // e.g. "/satellite/" -> "satellite"
  return window.location.pathname.split('/').filter(Boolean)[0] || 'satellite';
}

function getState() {
  return {
    domain: getDomain(),
    repo: localStorage.getItem('satproto_github_repo'),
    token: localStorage.getItem('satproto_github_token'),
  };
}

function getSecretKey() {
  return crypto.fromBase64(localStorage.getItem('satproto_secret_key'));
}

function getContentKey() {
  return crypto.fromBase64(localStorage.getItem('satproto_content_key'));
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function generatePostId() {
  const iso = new Date().toISOString();
  const compact = iso.replace(/-/g, '').replace(/:/g, '');
  const base = compact.split('.')[0] + 'Z';
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${base}-${hex}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// --- Pending post cache (optimistic UI) ---

const PENDING_KEY = 'satproto_pending_posts';
const PENDING_FOLLOWS_KEY = 'satproto_pending_follows';

function savePendingFollow(target) {
  const pending = getPendingFollows();
  if (!pending.includes(target)) pending.push(target);
  localStorage.setItem(PENDING_FOLLOWS_KEY, JSON.stringify(pending));
}

function getPendingFollows() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_FOLLOWS_KEY) || '[]');
  } catch {
    return [];
  }
}

function clearSyncedFollows(remoteFollows) {
  const remoteSet = new Set(remoteFollows);
  const remaining = getPendingFollows().filter((f) => !remoteSet.has(f));
  localStorage.setItem(PENDING_FOLLOWS_KEY, JSON.stringify(remaining));
  return remaining;
}

function removePendingFollow(target) {
  const remaining = getPendingFollows().filter((f) => f !== target);
  localStorage.setItem(PENDING_FOLLOWS_KEY, JSON.stringify(remaining));
}

function savePendingPost(post) {
  const pending = getPendingPosts();
  pending.push({ ...post, _pending: true });
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function getPendingPosts() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}

function clearSyncedPosts(remoteIds) {
  const pending = getPendingPosts();
  const remaining = pending.filter((p) => !remoteIds.has(p.id));
  localStorage.setItem(PENDING_KEY, JSON.stringify(remaining));
  return remaining;
}

// --- UI ---

function showSetup() {
  document.getElementById('setup-panel').style.display = 'block';
  document.getElementById('main-ui').style.display = 'none';
  setStatus('Sign in with GitHub to get started.');
}

function showMain() {
  document.getElementById('setup-panel').style.display = 'none';
  document.getElementById('main-ui').style.display = 'block';
  document.getElementById('follow-panel').style.display = 'block';
}

// --- Bootstrap ---

function selfDataEntry(repo, token, contentKey) {
  const pk = crypto.fromBase64(localStorage.getItem('satproto_public_key'));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ content_key: crypto.toBase64(contentKey), repo, token })
  );
  const sealed = crypto.sealBox(plaintext, pk);
  return github.textEntry(
    'keys/_self.json',
    JSON.stringify({ sealed_data: crypto.toBase64(sealed) })
  );
}

async function bootstrap({ replace = false } = {}) {
  const { token, repo, domain } = getState();
  const pk = localStorage.getItem('satproto_public_key');

  const contentKey = crypto.generateContentKey();
  localStorage.setItem('satproto_content_key', crypto.toBase64(contentKey));

  const push = replace ? github.replaceAllFiles : github.pushFiles;
  await push(token, repo, [
    github.textEntry('profile.json', JSON.stringify({
      satproto_version: '0.1.0',
      public_key: pk,
    })),
    github.textEntry('follows/index.json', JSON.stringify({ follows: [] })),
    github.textEntry('posts/index.json', JSON.stringify({ posts: [] })),
    selfDataEntry(repo, token, contentKey),
  ], 'bootstrap site');
  console.log('Site bootstrapped!');
}

// --- Actions ---

async function refreshFollows() {
  const { domain } = getState();
  try {
    const list = await feed.fetchFollowList(domain);
    const pendingFollows = clearSyncedFollows(list.follows);
    const el = document.getElementById('follows-list');
    const allFollows = [
      ...list.follows.map((f) => ({ domain: f, pending: false })),
      ...pendingFollows.map((f) => ({ domain: f, pending: true })),
    ];
    if (allFollows.length === 0) {
      el.innerHTML = '<span class="follows-empty">Not following anyone yet</span>';
      return;
    }
    el.innerHTML = allFollows
      .map(
        ({ domain: f, pending }) =>
          `<span class="follow-chip${pending ? ' follow-pending' : ''}">${escHtml(f)}${pending ? ' <span class="post-pending-label">syncing…</span>' : ''} <button onclick="doUnfollow('${escAttr(f)}')" class="unfollow-btn">x</button></span>`
      )
      .join('');
  } catch (e) {
    console.warn('Failed to load follows:', e);
  }
}

async function refreshFeed() {
  const { domain } = getState();
  setStatus('Loading feed...');
  try {
    const followList = await feed.fetchFollowList(domain);
    const sk = getSecretKey();
    const postArrays = [];

    const allFollowed = [...new Set([...followList.follows, ...getPendingFollows()])];
    for (const followed of allFollowed) {
      try {
        const posts = await feed.fetchUserPosts(
          followed,
          domain,
          sk,
          DEFAULT_FEED_LIMIT
        );
        postArrays.push(posts);
      } catch (e) {
        console.warn(`Failed to fetch from ${followed}:`, e);
      }
    }

    // Clear synced pending posts and merge remaining ones
    const remoteIds = new Set(postArrays.flat().map((p) => p.id));

    // Also check own remote post index so pending posts authored by self get cleared
    try {
      const ownIndex = await feed.fetchPostIndex(domain);
      for (const id of ownIndex.posts) remoteIds.add(id);
    } catch {
      // not yet published, ignore
    }
    const pendingPosts = clearSyncedPosts(remoteIds);
    if (pendingPosts.length > 0) {
      postArrays.push(pendingPosts);
    }

    const merged = feed.mergeFeed(postArrays);

    // Split into top-level posts and replies
    const topLevel = [];
    const replies = [];
    for (const post of merged) {
      if (post.reply_to) {
        replies.push(post);
      } else {
        topLevel.push(post);
      }
    }

    // Build a set of top-level post keys for quick lookup
    const topLevelKeys = new Set(
      topLevel.map((p) => p.author + '\0' + p.id)
    );

    // Group replies by parent, dropping replies to inaccessible posts
    const replyMap = new Map();
    for (const r of replies) {
      const key = r.reply_to_author + '\0' + r.reply_to;
      if (!topLevelKeys.has(key)) continue;
      if (!replyMap.has(key)) replyMap.set(key, []);
      replyMap.get(key).push(r);
    }

    // Sort each reply group by created_at ascending
    for (const group of replyMap.values()) {
      group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    // Attach replies to their parent
    for (const post of topLevel) {
      const key = post.author + '\0' + post.id;
      post._replies = replyMap.get(key) || [];
    }

    renderFeed(topLevel);
    setStatus(
      topLevel.length
        ? ''
        : 'No posts yet. Follow someone or write your first post!'
    );
  } catch (e) {
    setStatus('Error loading feed: ' + e);
  }
}

function renderFeed(posts) {
  const el = document.getElementById('feed');
  el.innerHTML = '';
  for (const post of posts) {
    const div = document.createElement('div');
    div.className = 'post';

    if (post._pending) div.classList.add('post-pending');

    let html = '';
    html += `<span class="post-author">${escHtml(post.author)}</span>`;
    if (post._pending) {
      html += `<span class="post-pending-label">syncing…</span>`;
    }
    html += `<span class="post-time">${new Date(post.created_at).toLocaleString()}</span>`;
    html += `<div class="post-text">${escHtml(post.text)}</div>`;
    html += `<div class="post-actions">`;
    html += `<button onclick="doReply('${escAttr(post.id)}','${escAttr(post.author)}')">reply</button>`;
    html += `</div>`;

    if (post._replies && post._replies.length > 0) {
      for (const reply of post._replies) {
        html += `<div class="reply${reply._pending ? ' post-pending' : ''}">`;
        html += `<span class="post-author">${escHtml(reply.author)}</span>`;
        if (reply._pending) {
          html += `<span class="post-pending-label">syncing…</span>`;
        }
        html += `<span class="post-time">${new Date(reply.created_at).toLocaleString()}</span>`;
        html += `<div class="post-text">${escHtml(reply.text)}</div>`;
        html += `</div>`;
      }
    }

    div.innerHTML = html;
    el.appendChild(div);
  }
}

// --- Global handlers (called from HTML) ---

window.saveSetup = async function () {
  const token = document.getElementById('token-input').value.trim();
  if (!token) return alert('Token is required');

  setStatus('Initializing your site...');
  try {
    const username = await github.getAuthenticatedUser(token);
    const repo = `${username}/${getRepoName()}`;
    localStorage.setItem('satproto_github_repo', repo);
    localStorage.setItem('satproto_github_token', token);

    await bootstrap();
    showMain();
    setStatus('Ready! Write your first post or follow someone.');

    const sk = localStorage.getItem('satproto_secret_key');
    if (sk && confirm('Save your secret key now — you need it to sign back in after clearing your browser cache.\n\nCopy to clipboard?')) {
      navigator.clipboard.writeText(sk).then(
        () => alert('Secret key copied to clipboard. Store it somewhere safe!'),
        () => prompt('Copy your secret key:', sk)
      );
    }
  } catch (e) {
    setStatus('Initialization failed: ' + e);
  }
};

window.signIn = async function () {
  const sk = document.getElementById('secret-key-input').value.trim();
  if (!sk) return alert('Secret key is required');

  try {
    const domain = getDomain();
    const secretKey = crypto.fromBase64(sk);
    const publicKey = crypto.derivePublicKey(secretKey);

    // Fetch and decrypt self data from the site
    const envelope = await feed.fetchSelfData(domain);
    const sealed = crypto.fromBase64(envelope.sealed_data);
    const decrypted = crypto.openSealedBox(sealed, secretKey);
    const selfData = JSON.parse(new TextDecoder().decode(decrypted));

    localStorage.setItem('satproto_github_repo', selfData.repo);
    localStorage.setItem('satproto_github_token', selfData.token);
    localStorage.setItem('satproto_secret_key', sk);
    localStorage.setItem('satproto_public_key', crypto.toBase64(publicKey));
    localStorage.setItem('satproto_content_key', selfData.content_key);

    document.getElementById('public-key-display').textContent =
      `Public key: ${crypto.toBase64(publicKey)}`;
    showMain();
    await refreshFollows();
    await refreshFeed();
    setStatus('Signed in!');
  } catch (e) {
    alert('Sign in failed: ' + e);
  }
};

window.exportKeys = function () {
  const sk = localStorage.getItem('satproto_secret_key');
  if (!sk) return alert('No key to export');
  navigator.clipboard.writeText(sk).then(
    () => alert('Secret key copied to clipboard. Store it somewhere safe!'),
    () => prompt('Copy your secret key:', sk)
  );
};

window.reinitialize = async function () {
  if (
    !confirm(
      'Re-initialize your site? This will permanently delete all posts, follows, and reset your profile.'
    )
  )
    return;
  setStatus('Re-initializing...');
  try {
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(PENDING_FOLLOWS_KEY);
    await bootstrap({ replace: true });
    setStatus('Site re-initialized!');
    await refreshFeed();
  } catch (e) {
    setStatus('Re-initialize failed: ' + e);
  }
};

async function publishPost(post) {
  const { token, repo } = getState();
  const contentKey = getContentKey();
  const encrypted = crypto.encryptData(
    new TextEncoder().encode(JSON.stringify(post)), contentKey
  );
  const index = await feed.fetchPostIndexOrEmpty(getDomain());
  index.posts.unshift(post.id);
  await github.pushFiles(token, repo, [
    github.binaryEntry(`posts/${post.id}.json.enc`, encrypted),
    github.textEntry('posts/index.json', JSON.stringify(index)),
  ], post.reply_to ? `reply: ${post.id}` : `new post: ${post.id}`);
  savePendingPost(post);
  await refreshFeed();
}

window.submitPost = async function () {
  const { domain } = getState();
  const text = document.getElementById('post-text').value.trim();
  if (!text) return;

  const btn = document.getElementById('post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  try {
    await publishPost({
      id: generatePostId(),
      author: domain,
      created_at: new Date().toISOString(),
      text,
    });
    document.getElementById('post-text').value = '';
  } catch (e) {
    alert('Failed to post: ' + e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post';
  }
};

window.doFollow = async function () {
  const { domain, token, repo } = getState();
  const target = document.getElementById('follow-domain-input').value.trim();
  if (!target) return;

  const btn = document.getElementById('follow-btn');
  btn.disabled = true;
  btn.textContent = 'Following...';

  try {
    // Fetch target's public key
    const profile = await feed.fetchProfile(target);
    const targetPk = crypto.fromBase64(profile.public_key);

    // Encrypt our content key for them
    const contentKey = getContentKey();
    const sealed = crypto.sealBox(contentKey, targetPk);
    const envelope = {
      recipient: target,
      encrypted_key: crypto.toBase64(sealed),
    };
    // Update follow list
    const list = await feed.fetchFollowListOrEmpty(domain);
    if (!list.follows.includes(target)) {
      list.follows.push(target);
    }

    await github.pushFiles(token, repo, [
      github.textEntry(`keys/${target}.json`, JSON.stringify(envelope)),
      github.textEntry('follows/index.json', JSON.stringify(list)),
    ], `follow ${target}`);

    document.getElementById('follow-domain-input').value = '';
    savePendingFollow(target);
    await refreshFollows();
    await refreshFeed();
  } catch (e) {
    alert('Failed to follow: ' + e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Follow';
  }
};

window.doUnfollow = async function (target) {
  if (!confirm(`Unfollow ${target}? This will re-encrypt all your posts.`))
    return;

  removePendingFollow(target);
  const { domain, token, repo } = getState();
  setStatus(`Unfollowing ${target}...`);

  try {
    const oldContentKey = getContentKey();

    // Fetch post index
    const index = await feed.fetchPostIndexOrEmpty(domain);

    // Generate new content key
    const newContentKey = crypto.generateContentKey();
    localStorage.setItem('satproto_content_key', crypto.toBase64(newContentKey));

    const files = [];

    // Re-encrypt each post
    const satBase = await feed.getSatBase(domain);
    for (const postId of index.posts) {
      try {
        const resp = await fetch(
          `${satBase}/posts/${postId}.json.enc`
        );
        if (!resp.ok) continue;
        const encrypted = new Uint8Array(await resp.arrayBuffer());
        const decrypted = crypto.decryptData(encrypted, oldContentKey);
        const reEncrypted = crypto.encryptData(decrypted, newContentKey);
        files.push(github.binaryEntry(`posts/${postId}.json.enc`, reEncrypted));
      } catch (e) {
        console.warn(`Failed to re-encrypt post ${postId}:`, e);
      }
    }

    // Update follow list
    const list = await feed.fetchFollowListOrEmpty(domain);
    list.follows = list.follows.filter((d) => d !== target);

    // Re-create key envelopes for remaining followers
    for (const follower of list.follows) {
      try {
        const profile = await feed.fetchProfile(follower);
        const pk = crypto.fromBase64(profile.public_key);
        const sealed = crypto.sealBox(newContentKey, pk);
        const envelope = {
          recipient: follower,
          encrypted_key: crypto.toBase64(sealed),
        };
        files.push(github.textEntry(`keys/${follower}.json`, JSON.stringify(envelope)));
      } catch (e) {
        console.warn(`Failed to update key for ${follower}:`, e);
      }
    }

    files.push(github.textEntry('follows/index.json', JSON.stringify(list)));
    files.push(selfDataEntry(repo, token, newContentKey));

    await github.pushFiles(token, repo, files, `unfollow ${target}`);

    await refreshFollows();
    await refreshFeed();
  } catch (e) {
    alert('Failed to unfollow: ' + e);
  }
};

window.doReply = async function (postId, postAuthor) {
  const text = prompt('Reply:');
  if (!text) return;
  const { domain } = getState();
  try {
    await publishPost({
      id: generatePostId(),
      author: domain,
      created_at: new Date().toISOString(),
      text,
      reply_to: postId,
      reply_to_author: postAuthor,
    });
  } catch (e) {
    alert('Failed to reply: ' + e);
  }
};


// --- Init ---

function updateTokenLink() {
  const repoName = getRepoName();
  const params = new URLSearchParams({
    name: 'sAT Proto',
    description: `Choose "Only select repositories"\nSelect "${repoName}"\nClick "Add permissions"\nChoose "Contents"\nSet "Access: Read and write"`,
  });
  document.getElementById('token-link').href =
    `https://github.com/settings/personal-access-tokens/new?${params}`;
  document.getElementById('repo-hint').textContent = repoName;
}

async function start() {
  await crypto.init();

  // Generate keypair if needed
  if (!localStorage.getItem('satproto_secret_key')) {
    const kp = crypto.generateKeypair();
    localStorage.setItem('satproto_secret_key', crypto.toBase64(kp.secretKey));
    localStorage.setItem('satproto_public_key', crypto.toBase64(kp.publicKey));
    console.log('Generated new keypair');
  }

  const pk = localStorage.getItem('satproto_public_key');
  document.getElementById('public-key-display').textContent =
    `Public key: ${pk}`;

  updateTokenLink();

  const { repo, token } = getState();
  if (repo && token) {
    showMain();
    await refreshFollows();
    await refreshFeed();
  } else {
    showSetup();
  }
}

start().catch((e) => {
  setStatus('Failed to initialize: ' + e);
  console.error(e);
});
