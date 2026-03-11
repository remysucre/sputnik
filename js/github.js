// GitHub Contents API for pushing files to a repo

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function getFileSha(token, repo, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.sha || null;
}

async function pushFile(token, repo, path, contentBase64) {
  const sha = await getFileSha(token, repo, path);
  const body = { message: `update: ${path}`, content: contentBase64 };
  if (sha) body.sha = sha;

  const resp = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error for ${path}: ${text}`);
  }
}

export async function pushTextFile(token, repo, path, content) {
  const bytes = new TextEncoder().encode(content);
  await pushFile(token, repo, path, uint8ToBase64(bytes));
}

export async function pushBinaryFile(token, repo, path, data) {
  await pushFile(token, repo, path, uint8ToBase64(new Uint8Array(data)));
}
