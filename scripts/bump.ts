import fs from "node:fs";
import path from "node:path";
import { exec } from "@actions/exec";

process.chdir(path.join(import.meta.dirname, ".."));

await exec("shiprig", ["version", "--yes"]);

// read after versioning to get the new version
const pkgJson = (await import("../package.json", { with: { type: "json" } }))
  .default;
const releaseLine = `v${pkgJson.version.split(".")[0]}`;

// Point every example at the release line: the root action and the
// sub-actions (rigsmith/shiprig-action/<name>@vN). Only whole version refs
// (v1, v1.2.3) move; branch or build refs are left alone, and trailing
// punctuation such as a closing backtick survives.
for (const readme of [
  "README.md",
  ...fs
    .readdirSync(".", { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && fs.existsSync(path.join(e.name, "README.md")),
    )
    .map((e) => path.join(e.name, "README.md")),
]) {
  const content = fs.readFileSync(readme, "utf8");
  const updated = content.replace(
    /rigsmith\/shiprig-action((?:\/[a-z-]+)?)@v\d+(?:\.\d+)*(?![\w/+-]|\.\d)/g,
    `rigsmith/shiprig-action$1@${releaseLine}`,
  );
  if (updated !== content) fs.writeFileSync(readme, updated);
}
