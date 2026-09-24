import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execShiprig, hasChangesetFiles, readReleasePlan } from "../shiprig.ts";

export type ModeResult =
  | {
      mode: "none";
    }
  | {
      mode: "version";
    }
  | {
      mode: "publish";
      publishPlanPath: string;
    };

export type PublishPlan = unknown[];

export async function getMode(cwd: string): Promise<ModeResult> {
  // shiprig's plan says whether a release is pending, from changesets or
  // conventional commits alike (upstream reads the changeset files). Files
  // that release nothing (empty, or naming only ignored packages) leave
  // nothing to version and nothing to publish yet, as upstream has it.
  const releases = await readReleasePlan(cwd);
  if (releases.some((r) => r.type !== "none")) {
    return { mode: "version" };
  }
  if (await hasChangesetFiles(cwd)) {
    return { mode: "none" };
  }

  const publishPlanPath = path.join(
    process.env.RUNNER_TEMP ?? (await fs.realpath(os.tmpdir())),
    `changeset-publish-plan-${Date.now()}`,
    // we need a stable filename here (in a unique dirname) so the artifact download can find this cleanly
    "publish-plan.json",
  );
  // `shiprig publish-plan` asks each registry what isn't there yet, as
  // `changeset publish-plan` does, and writes the same file.
  await execShiprig(["publish-plan", "--output", publishPlanPath], {
    cwd,
    env: process.env,
  });

  const publishPlan = await readPublishPlan(publishPlanPath);
  if (publishPlan.length === 0) {
    return { mode: "none" };
  }

  return {
    mode: "publish",
    publishPlanPath,
  };
}

async function readPublishPlan(publishPlanPath: string): Promise<PublishPlan> {
  let rawPlan: string;
  try {
    rawPlan = await fs.readFile(publishPlanPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read publish plan at ${publishPlanPath}`, {
      cause: err,
    });
  }

  let plan: unknown;
  try {
    plan = JSON.parse(rawPlan);
  } catch (err) {
    throw new Error(`Failed to parse publish plan at ${publishPlanPath}`, {
      cause: err,
    });
  }

  if (
    typeof plan !== "object" ||
    plan === null ||
    !("version" in plan) ||
    typeof plan.version !== "number" ||
    !("plan" in plan) ||
    !Array.isArray(plan.plan)
  ) {
    throw new Error(
      `Invalid publish plan at ${publishPlanPath}: expected { version: number; plan: unknown[] }`,
    );
  }
  return plan.plan;
}
