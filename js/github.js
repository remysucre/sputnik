// GitHub API helpers for pushing files to a repo

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

// Build a file entry for a text file (for use with pushFiles)
export function textEntry(path, content) {
  return { path, content: uint8ToBase64(new TextEncoder().encode(content)) };
}

// Build a file entry for a binary file (for use with pushFiles)
export function binaryEntry(path, data) {
  return { path, content: uint8ToBase64(new Uint8Array(data)) };
}

// Returns the authenticated user's login for the given token.
export async function getAuthenticatedUser(token) {
  const resp = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  if (!resp.ok) throw new Error('Invalid token or unable to fetch GitHub user');
  return (await resp.json()).login;
}

async function createBlobs(api, headers, files) {
  return Promise.all(
    files.map(async (f) => {
      const blobResp = await fetch(`${api}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: f.content, encoding: 'base64' }),
      });
      if (!blobResp.ok) throw new Error(`Failed to create blob for ${f.path}`);
      return { path: f.path, mode: '100644', type: 'blob', sha: (await blobResp.json()).sha };
    })
  );
}

async function commitAndPush(api, headers, treeSha, parentSha, message) {
  const commitResp = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!commitResp.ok) throw new Error('Failed to create commit');
  const commitSha = (await commitResp.json()).sha;

  const updateResp = await fetch(`${api}/git/refs/heads/main`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: commitSha }),
  });
  if (!updateResp.ok) throw new Error('Failed to update branch ref');
}

// Push multiple files in a single commit, merging into the existing tree.
export async function pushFiles(token, repo, files, message) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = ghHeaders(token);

  const refResp = await fetch(`${api}/git/ref/heads/main`, { headers });
  if (!refResp.ok) throw new Error('Failed to get branch ref');
  const baseSha = (await refResp.json()).object.sha;

  const commitResp = await fetch(`${api}/git/commits/${baseSha}`, { headers });
  if (!commitResp.ok) throw new Error('Failed to get base commit');
  const baseTreeSha = (await commitResp.json()).tree.sha;

  const tree = await createBlobs(api, headers, files);

  const treeResp = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeResp.ok) throw new Error('Failed to create tree');

  await commitAndPush(api, headers, (await treeResp.json()).sha, baseSha, message);
}
