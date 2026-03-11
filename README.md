# sAT Protocol

sAT Protocol (`s@`) is a decentralized social networking protocol based on static sites.
Each user owns a static website storing all their data in encrypted JSON stores.
A client running in the browser aggregates feeds and publishes posts.
It does not rely on any servers or relays.

In plain terms, `s@` is designed for you and your friends, and no one else.
This applies to both the technical implementation and the user experience.
At the technical level, data only moves from your own website to your friend's browser.
There are no servers (like Mastodon) or relays (like the AT Protocol) in the middle.
And unlike almost all social media platform today, 
 `s@` is not designed for *influencers*.
To see a friend's post or to have a friend see your post, you must follow *each other*[^1].
Of course it is still possible for a malicious actors to crawl and follow everyone,
 but they would probably prefer a different platform anyways.

[^1]: How do you ask a friend to follow? Idk, text them. Or just ask them in person. You're friends, right?

See [Setup](#setup) to deploy a sample implementation using GitHub Pages.

## Identity

A user's identity is their domain name.
Identity is authenticated by HTTPS/TLS - fetching content from a domain proves
the domain owner published it.

## Discovery

A `s@`-enabled site exposes a discovery document at:

```
GET https://{domain}/satellite/satproto.json
```

By convention, the client looks under `/satellite/` by default.
If the data lives in a differently-named repo, place a `satellite.json`
file at the domain root (e.g. in the `username.github.io` repo) containing:

```json
{ "sat_repo": "my-custom-repo" }
```

The discovery document itself contains the user's profile:

```json
{
  "satproto_version": "0.1.0",
  "handle": "alice.com",
  "display_name": "Alice",
  "bio": "Hello world",
  "public_key": "<base64-encoded X25519 public key>"
}
```

## Encryption Model

All user data is stored in an encrypted JSON store. 
Only users in the owner's follow list can decrypt it.

### Keys

- Each user generates an **X25519 keypair**.
  The public key is published in the discovery document.
  The private key is stored in the browser's localStorage.
- A random **content key** (256-bit symmetric key) encrypts
  post data with XChaCha20-Poly1305.
- The content key is encrypted per-follower using libsodium sealed boxes
  (`crypto_box_seal` with the follower's X25519 public key)
  and stored at `keys/{follower-domain}.json`.

### Self Key (`keys/_self.json`)

The user's content key, GitHub repo, and GitHub token are bundled into
a single sealed box (`crypto_box_seal` with the user's own public key)
and stored at `keys/_self.json`. Only the user's private key can open it.

This allows a user to sign back in on a new device or after clearing
browser storage — they only need their domain and private key.

### Key Rotation (Unfollow)

When the user unfollows someone:
1. Generate a new content key
2. Re-encrypt all posts with the new key
3. Re-create key envelopes for all remaining followers
4. Update `keys/_self.json` with the new content key
5. The unfollowed user's old key no longer decrypts anything

### Decryption Flow

When Bob visits Alice's site:
1. Fetch Alice's `/satellite/satproto.json` to get her public key
2. Fetch `keys/bob.example.com.json`
3. Decrypt the content key using Bob's private key (`crypto_box_seal_open`)
4. Fetch `posts/index.json` to get the list of post IDs
5. Fetch and decrypt individual posts from `posts/{id}.json.enc`
   (XChaCha20-Poly1305 with the content key)

## Data Schema

Each post is stored as an individually encrypted file. The post index
(`posts/index.json`) is a plaintext JSON file listing post IDs
newest-first, allowing clients to lazily load only recent posts.

A post object:

```json
{
  "id": "20260309T141500Z-a1b2",
  "author": "alice.com",
  "created_at": "2026-03-09T14:15:00Z",
  "text": "Hello, decentralized world!",
  "reply_to": null,
  "reply_to_author": null,
  "repost_of": null,
  "repost_of_author": null
}
```

Post IDs are `{ISO8601-compact-UTC}-{4-hex-random}`, e.g. `20260309T141500Z-a1b2`.
The timestamp prefix gives natural sort order; the random suffix prevents collisions.

### Reposts

A repost is a post with `repost_of` and `repost_of_author` set. The `text`
field may be empty (pure repost) or contain commentary (quote repost).

When a client encounters a repost, it fetches and decrypts the original post
from the original author's site. This means:
- The original content is always authenticated by the original author's TLS
  and encryption — reposters cannot forge content.
- If the original author deletes or edits the post, the repost reflects that.
- If the viewer doesn't have access to the original author's data (the original
  author doesn't follow them), they see the repost attribution without content.

## Follow List

The follow list is stored as a plain JSON file (unencrypted, since the key
envelopes already reveal follows):

```
GET https://{domain}/satellite/follows/index.json
```

```json
{
  "follows": ["bob.example.com", "carol.example.com"]
}
```

## Feed Aggregation

The client builds a feed by:
1. Reading the user's follow list
2. For each followed user, fetching their discovery document
3. For each followed user, decrypting their posts (using the key envelope
   the followed user published for this user)
4. Merging all posts, sorted by `created_at` descending

## Replies

A reply is a post with `reply_to` and `reply_to_author` set. Replies are
aggregated the same way as regular posts. A user only sees replies from people
they follow — this is the spam prevention mechanism.

When viewing a post, the client scans followed users' posts for entries where
`reply_to` matches the post ID and `reply_to_author` matches the post's author.

## Publishing

The client publishes posts by:
1. Creating a new post with a unique ID
2. Encrypting the post JSON with the content key
3. Pushing the encrypted post as `posts/{id}.json.enc` via the GitHub Contents API
4. Updating `posts/index.json` to include the new post ID

The GitHub token is encrypted in `keys/_self.json` (see [Self Key](#self-key-keys_selfjson)).

## Static Site Structure

```
{domain}/satellite/
  satproto.json             # Discovery + profile + public key
  posts/
    index.json              # Post ID list (plaintext, newest first)
    {id}.json.enc           # Individually encrypted post files
  follows/
    index.json              # Follow list (unencrypted)
  keys/
    _self.json              # Sealed box: content key + credentials (owner only)
    {domain}.json           # Sealed box: content key for follower
```

## Setup

```
🚧🚧 This app is meant to demonstrate the main ideas of s@    🚧🚧
🚧🚧 and is not (yet) a robust implementation. In particular, 🚧🚧
🚧🚧 each interaction is slow because it's literally making a 🚧🚧
🚧🚧 commit to GitHub and waiting for the page to update.     🚧🚧
```

Below are steps to set up a sample implementation of `s@` using GitHub.
The protocol itself is agnostic to how the site is hosted,
 and there is plan to support other hosts in the future.

### Quick start

1. Use this template repo to create a new repo named `satellite` (see [below](#using-a-custom-repo-name) if you want a different name)
2. Enable [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-from-a-branch) on the repo (deploy from the `main` branch).
3. Visit the GitHub Pages URL (e.g. `https://username.github.io/satellite/`)

### Using a custom repo name

By default, the client looks for data at `https://{domain}/satellite/`.
If you name your repo something other than `satellite`, add a `satellite.json`
file to the root of your main site (e.g. the `username.github.io` repo)
pointing to the actual repo:

```json
{ "sat_repo": "my-custom-repo" }
```
