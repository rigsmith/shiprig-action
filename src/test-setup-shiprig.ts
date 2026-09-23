// The tests run the real shiprig. An older one on PATH lacks the contracts
// the action uses and fails in confusing ways, so the binary is named
// explicitly: CI installs the pinned release from npm; locally, do the same
// (or build rigsmith) and point SHIPRIG_BIN at it.
export default function setup() {
  if (!process.env.SHIPRIG_BIN) {
    throw new Error(
      "Set SHIPRIG_BIN to a shiprig >= 1.20.0 binary to run the tests, e.g. " +
        "`npm install --prefix /tmp/shiprig @rigsmith/shiprig@1.20.0` and " +
        "SHIPRIG_BIN=/tmp/shiprig/node_modules/.bin/shiprig.",
    );
  }
}
