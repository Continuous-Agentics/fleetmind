/**
 * Mint an RS256 JWT for authenticating as a GitHub App.
 *
 * GitHub App auth flow:
 *   1. App holds a PEM private key (from the App settings).
 *   2. To call App-level endpoints (e.g. list installations, repo
 *      installation lookup), App mints a short-lived JWT signed with that
 *      key, claims = { iat, exp, iss: app_id }.
 *   3. JWT goes in `Authorization: Bearer <jwt>` for App-level requests.
 *
 * Spec: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * Uses Node's built-in `crypto.createSign` — no third-party JWT dep.
 */

import { createSign } from "node:crypto";

/** Mint a JWT valid for ~10 minutes (GitHub's max-allowed expiry is 10min). */
export function mintAppJwt(pem: string, appId: string, opts?: { now?: number; ttlSec?: number }): string {
  const now = Math.floor((opts?.now ?? Date.now()) / 1000);
  // GitHub recommends iat=now-60 to tolerate small clock skew between caller
  // and GitHub's servers. They reject JWTs whose iat is in the future.
  const iat = now - 60;
  const exp = now + (opts?.ttlSec ?? 600);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat, exp, iss: appId };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(pem);
  const sigB64 = base64UrlEncode(signature);

  return `${signingInput}.${sigB64}`;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
