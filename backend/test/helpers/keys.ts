/** A fresh RSA private JWK (test-only), for assertions signed by a key Access does not use. */
export async function generateKeyPair(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ ...jwk, kid: 'test-access-key' });
}
