import net from "node:net";
import { expect, it } from "vitest";
import { createGitHttpRemote } from "./test-utils.ts";

// A Git HTTP remote's port must be its own on the address its URL names. If
// another process can still listen on 127.0.0.1 at that port, it receives the
// requests meant for the remote (on macOS, a `::` listener allows exactly that).
it("owns its loopback port", async () => {
  await using remote = await createGitHttpRemote({ "file.txt": "initial\n" });
  const { hostname, port } = new URL(remote.url);

  const impostor = net.createServer();
  const bound = await new Promise<boolean | string>((resolve) => {
    impostor.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? String(error)),
    );
    impostor.listen(Number(port), hostname, () => resolve(true));
  });
  impostor.close();

  expect(bound).toBe("EADDRINUSE");
});
