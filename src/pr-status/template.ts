import { humanId } from "human-id";
import { changedPackages } from "./preview.ts";

export function getNewChangesetUrl(
  headRepoUrl: string,
  headRef: string,
  templateContent: string,
) {
  const fileName = humanId({ separator: "-", capitalize: false });
  return `${headRepoUrl}/new/${headRef}?filename=.changeset/${fileName}.md&value=${encodeURIComponent(templateContent)}`;
}

/**
 * A changeset for the packages the pull request changes, at patch, with its
 * title as the summary: the file a maintainer's "add a changeset" link opens.
 * Packages come from shiprig, so every ecosystem it knows is covered.
 */
export async function getNewChangesetTemplateContent(
  cwd: string,
  baseRef: string,
  prTitle: string,
) {
  const packages = await changedPackages(cwd, baseRef);
  return `\
---
${packages.map((name) => `"${name}": patch`).join("\n")}
---

${prTitle}
`;
}
