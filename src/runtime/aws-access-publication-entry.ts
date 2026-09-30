/** Root-only fixed-path publication. No runtime path or credential overrides. */
import { publishAccess } from "./aws-access-publication.js";
try {
  if (process.getuid?.() !== 0) throw new Error("Root required");
  const payload = process.argv[2];
  if (!payload || payload.length > 100_000 || !/^[A-Za-z0-9+/]+=*$/.test(payload)) throw new Error("Invalid payload");
  const input = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  if (!Object.hasOwn(input, "catalog")) throw new Error("Missing catalog");
  process.stdout.write(await publishAccess(input.catalog, input.host, input.revision) + "\n");
} catch {
  process.stderr.write("AWS access publication denied; catalog not authorized for this host.\n");
  process.exitCode = 1;
}
