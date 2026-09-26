import * as fs from "node:fs/promises";
import path from "node:path";
import { markdownTable } from "markdown-table";
import * as yaml from "yaml";

await main();

async function main() {
  const problems: string[] = [];
  // Every README is checked before any is written, so a problem the checks
  // find leaves the whole set as it was rather than half regenerated. (A
  // write that fails partway can still leave a mix; the CI step's git diff
  // shows it, and a rerun finishes the job.)
  const writes: [string, string][] = [];
  // Every published action (the repository's own CI helpers under .github/
  // aside) documents its inputs and outputs in a README beside it.
  for await (const actionPath of fs.glob("**/action.yml", {
    exclude: ["**/node_modules/**", ".github/**"],
  })) {
    const readmePath = path.join(path.dirname(actionPath), "README.md");
    const readmeExists = await fs.stat(readmePath).catch(() => null);
    if (!readmeExists) {
      problems.push(
        `${actionPath}: has no README.md beside it for its API table`,
      );
      continue;
    }

    const action = yaml.parse(await fs.readFile(actionPath, "utf8"));
    const inputs = action.inputs ?? {};
    const outputs = action.outputs ?? {};

    const content = [
      renderSection("Inputs", inputs),
      renderSection("Outputs", outputs),
    ].join("\n\n");

    const readme = await fs.readFile(readmePath, "utf8");
    // Exactly one marker pair, start before end: a README missing its markers
    // or carrying two pairs would otherwise be left stale with nothing to say
    // so, and CI's freshness check trusts this to have written every table.
    const starts = readme.split("<!-- api-start -->").length - 1;
    const ends = readme.split("<!-- api-end -->").length - 1;
    if (
      starts !== 1 ||
      ends !== 1 ||
      readme.indexOf("<!-- api-start -->") > readme.indexOf("<!-- api-end -->")
    ) {
      problems.push(
        `${readmePath}: needs exactly one <!-- api-start --> … <!-- api-end --> pair (found ${starts} start, ${ends} end)`,
      );
      continue;
    }
    const updated = readme.replace(
      /<!-- api-start -->[\s\S]*?<!-- api-end -->/,
      `<!-- api-start -->\n\n${content}\n\n<!-- api-end -->`,
    );
    writes.push([readmePath, updated]);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
    return;
  }
  for (const [readmePath, updated] of writes) {
    await fs.writeFile(readmePath, updated);
  }
}

function renderSection(title: string, entries: Record<string, any>) {
  const rows: string[][] = [];
  for (const [name, entry] of Object.entries(entries)) {
    let description = (entry.description ?? "")
      .trim()
      .replace(/\|/g, "\\|")
      // An HTML comment opener in a description would read as a marker (or
      // hide the rest of the table); `&lt;` renders the same.
      .replaceAll("<!--", "&lt;!--");
    if (entry.required) description = `**Required.** ${description}`;
    rows.push([`\`${name}\``, description]);
  }
  if (rows.length === 0) {
    return `${title}: _none_`;
  }
  rows.unshift([title, "Description"]);
  return markdownTable(rows);
}
