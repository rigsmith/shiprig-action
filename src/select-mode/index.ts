import path from "node:path";
import artifact from "@actions/artifact";
import * as core from "@actions/core";
import { requireShiprig } from "../shiprig.ts";
import { getOptionalInput } from "../utils.ts";
import { getMode } from "./mode.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  await requireShiprig();
  const cwd = getOptionalInput("cwd") || process.cwd();

  const result = await getMode(cwd);
  core.setOutput("mode", result.mode);
  if (result.mode === "publish") {
    const publishPlanArtifact = await artifact.uploadArtifact(
      path.basename(result.publishPlanPath, ".json"),
      [result.publishPlanPath],
      path.dirname(result.publishPlanPath),
      {
        skipArchive: true,
        retentionDays: 30,
      },
    );
    if (publishPlanArtifact.id === undefined) {
      throw new Error(
        "Publish plan artifact upload did not return an artifact id",
      );
    }
    core.setOutput("publish-plan-artifact-id", String(publishPlanArtifact.id));
  }
}
