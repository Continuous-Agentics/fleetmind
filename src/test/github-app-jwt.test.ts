import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mintAppJwt } from "../runtime/github-app-jwt.js";

// Generate a fresh RSA keypair for tests (so we don't depend on a fixture).
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pub = publicKey.export({ type: "spki", format: "pem" }) as string;

function decodeBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "====".slice(0, 4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

describe("mintAppJwt", () => {
  it("produces a three-part JWT (header.payload.signature)", () => {
    const token = mintAppJwt(pem, "12345");
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    for (const p of parts) assert.ok(p.length > 0, "no empty JWT segment");
  });

  it("header declares RS256 + JWT", () => {
    const token = mintAppJwt(pem, "12345");
    const headerJson = JSON.parse(decodeBase64Url(token.split(".")[0]!).toString("utf-8"));
    assert.equal(headerJson.alg, "RS256");
    assert.equal(headerJson.typ, "JWT");
  });

  it("payload carries iat (now-60), exp (now+ttl), and iss=app_id", () => {
    const fixedNowMs = 1_700_000_000_000;
    const token = mintAppJwt(pem, "98765", { now: fixedNowMs, ttlSec: 600 });
    const payloadJson = JSON.parse(decodeBase64Url(token.split(".")[1]!).toString("utf-8"));
    const nowSec = Math.floor(fixedNowMs / 1000);
    assert.equal(payloadJson.iat, nowSec - 60);
    assert.equal(payloadJson.exp, nowSec + 600);
    assert.equal(payloadJson.iss, "98765");
  });

  it("signature verifies against the matching public key", () => {
    const token = mintAppJwt(pem, "12345");
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = decodeBase64Url(sigB64!);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    assert.equal(verifier.verify(pub, sig), true);
  });

  it("default TTL is 600 seconds (10 minutes — GitHub's max)", () => {
    const fixedNowMs = 1_700_000_000_000;
    const token = mintAppJwt(pem, "1", { now: fixedNowMs });
    const payloadJson = JSON.parse(decodeBase64Url(token.split(".")[1]!).toString("utf-8"));
    const nowSec = Math.floor(fixedNowMs / 1000);
    assert.equal(payloadJson.exp - payloadJson.iat, 660); // 600 ttl + 60 backdate
  });
});
