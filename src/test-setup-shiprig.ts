import { execFileSync } from "node:child_process";
import path from "node:path";

// The tests run the real shiprig: by default the exact version pinned in
// devDependencies (its tarball's integrity is in pnpm-lock.yaml), or
// SHIPRIG_BIN to test against another build. Either is checked for the
// contract the action relies on before any test runs, so a missing or older
// binary fails here with a clear message rather than inside the tests.
export default function setup() {
  const bin =
    process.env.SHIPRIG_BIN ||
    path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "shiprig");
  let help: string;
  try {
    help = execFileSync(bin, ["packages", "list", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A binary that hangs would otherwise hold every test behind it.
      timeout: 30_000,
    });
  } catch (err) {
    const timedOut = (err as { code?: string }).code === "ETIMEDOUT";
    throw new Error(
      timedOut
        ? `shiprig at ${bin} didn't answer \`packages list --help\` within 30s.`
        : `Can't run shiprig at ${bin}: run \`pnpm install\`, or set SHIPRIG_BIN to a shiprig >= 1.20.0.`,
      { cause: err },
    );
  }
  if (!help.includes("--json")) {
    throw new Error(
      `shiprig at ${bin} has no \`packages list --json\`: the tests need shiprig >= 1.20.0.`,
    );
  }
  process.env.SHIPRIG_BIN = bin;
}
