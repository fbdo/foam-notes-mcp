import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const fixtureRoot = (metaUrl: string): string =>
  resolve(dirname(fileURLToPath(metaUrl)), "..", "fixtures", "vault");
