import crypto from 'node:crypto';

export function generateToken() {
  return crypto.randomBytes(9).toString('base64url'); // 9 bytes → 12 URL-safe chars
}
