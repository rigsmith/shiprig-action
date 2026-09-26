import * as core from "@actions/core";
import * as github from "@actions/github";
import { requireShiprig } from "../shiprig.ts";
import { getCommentMessage } from "./message.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  await requireShiprig();
  const context = github.context.payload.pull_request;
  if (!context) {
    throw new Error(
      "This action should only be run on `pull_request_target` or `pull_request` events",
    );
  }

  core.info("Creating comment message...");
  const { body, unreleased } = await getCommentMessage(context);
  core.setOutput("comment-body", body);
  core.setOutput("unreleased-packages", JSON.stringify(unreleased));
  // A warning, never a failure: whether a change needs a release is the
  // author's call.
  if (unreleased.length > 0) {
    core.warning(
      `This PR changes ${unreleased.join(", ")}, and nothing in it releases ${unreleased.length === 1 ? "it" : "them"}.`,
      { title: "Changed but not released" },
    );
  }
  core.info("Done!");
}
