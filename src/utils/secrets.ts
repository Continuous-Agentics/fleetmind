/**
 * Local secret store — stored in ~/.fleetmind/secrets.json (chmod 600).
 */
import fs from "node:fs";
import path from "node:path";

const SECRETS_DIR = path.join(process.env.HOME ?? "/tmp", ".fleetmind");
const SECRETS_FILE = path.join(SECRETS_DIR, "secrets.json");

export function loadSecrets(): Record<string, string> {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSecret(key: string, value: string): void {
  const secrets = loadSecrets();
  secrets[key] = value;
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  process.env[key] = value;
}

export function injectSecrets(): void {
  const secrets = loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

export function listSecretKeys(): string[] {
  return Object.keys(loadSecrets()).sort();
}

export function exportSecrets(): string {
  return Object.entries(loadSecrets())
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n");
}
