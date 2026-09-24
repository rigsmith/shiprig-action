import { execFileSync } from "node:child_process";
import path from "node:path";
import { atLeast, MIN_SHIPRIG_VERSION } from "./shiprig.ts";

// The tests run the real shiprig: by default the exact version pinned in
// devDependencies (its tarball's integrity is in pnpm-lock.yaml), or
// SHIPRIG_BIN to test against another build. Either is checked against the
// action's minimum before any test runs, so a missing or older binary fails
// here with a clear message rather than inside the tests.
export default function setup() {
  const bin =
    process.env.SHIPRIG_BIN ||
    path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "shiprig");
  let version: string;
  try {
    // Piped, --version prints the bare version (shiprig 1.21.0 on).
    version = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A binary that hangs would otherwise hold every test behind it.
      timeout: 30_000,
    }).trim();
  } catch (err) {
    const timedOut = (err as { code?: string }).code === "ETIMEDOUT";
    throw new Error(
      timedOut
        ? `shiprig at ${bin} didn't answer \`--version\` within 30s.`
        : `Can't run shiprig at ${bin}: run \`pnpm install\`, or set SHIPRIG_BIN to a shiprig >= ${MIN_SHIPRIG_VERSION}.`,
      { cause: err },
    );
  }
  // A source build (SHIPRIG_BIN at a local build) has no version to check.
  if (
    !version.startsWith("source build") &&
    !atLeast(version, MIN_SHIPRIG_VERSION)
  ) {
    throw new Error(
      `shiprig at ${bin} is ${/^\d/.test(version) ? version : "older than 1.21.0 (its --version isn't a bare version)"}: the tests need shiprig >= ${MIN_SHIPRIG_VERSION}.`,
    );
  }
  process.env.SHIPRIG_BIN = bin;
}
