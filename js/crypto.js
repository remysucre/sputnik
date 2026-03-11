// Crypto operations using libsodium

import _sodium from 'libsodium-wrappers-sumo';

let sodium;

export async function init() {
  await _sodium.ready;
  sodium = _sodium;
}

export function generateKeypair() {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function generateContentKey() {
  return sodium.randombytes_buf(32);
}

export function sealContentKey(contentKey, recipientPk) {
  return sodium.crypto_box_seal(contentKey, recipientPk);
}

export function openContentKey(sealed, sk) {
  const pk = sodium.crypto_scalarmult_base(sk);
  return sodium.crypto_box_seal_open(sealed, pk, sk);
}

export function encryptData(plaintext, key) {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, null, null, nonce, key
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, nonce.length);
  return out;
}

export function decryptData(data, key) {
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = data.slice(0, nonceLen);
  const ciphertext = data.slice(nonceLen);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, null, nonce, key
  );
}

export function toBase64(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(str) {
  return sodium.from_base64(str, sodium.base64_variants.ORIGINAL);
}
