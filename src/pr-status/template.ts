import { humanId } from "human-id";

export function getNewChangesetUrl(
  headRepoUrl: string,
  headRef: string,
  templateContent: string,
) {
  const fileName = humanId({ separator: "-", capitalize: false });
  return `${headRepoUrl}/new/${headRef}?filename=.changeset/${fileName}.md&value=${encodeURIComponent(templateContent)}`;
}

/**
 * A changeset for the packages the pull request changes (changedPackages, from
 * shiprig, so every ecosystem it knows is covered), at patch, with its title as
 * the summary: the file a maintainer's "add a changeset" link opens.
 */
export function getNewChangesetTemplateContent(
  packages: string[],
  prTitle: string,
) {
  return `\
---
${packages.map((name) => `"${name}": patch`).join("\n")}
---

${prTitle}
`;
}
