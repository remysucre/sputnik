// GitHub OAuth device flow authentication
//
// Register an OAuth App at https://github.com/settings/applications/new
// Set the client ID below. No client secret is needed for the device flow.

const CLIENT_ID = 'Ov23liPGbiDN6zPOnkOX';
const SCOPE = 'public_repo';

export async function startDeviceFlow() {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!resp.ok) throw new Error('Failed to start device flow');
  return resp.json();
  // Returns { device_code, user_code, verification_uri, expires_in, interval }
}

export async function pollForToken(deviceCode, interval = 5) {
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await resp.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval = (data.interval || interval) + 1;
      continue;
    }
    throw new Error(data.error_description || data.error);
  }
}

export function getStoredToken() {
  return localStorage.getItem('satproto_github_token');
}

export function storeToken(token) {
  localStorage.setItem('satproto_github_token', token);
}
