// The tests run the real shiprig. An older one on PATH lacks the contracts
// the action uses and fails in confusing ways, so the binary is named
// explicitly: CI installs a pinned build; locally, build rigsmith and point
// SHIPRIG_BIN at it.
export default function setup() {
  if (!process.env.SHIPRIG_BIN) {
    throw new Error(
      "Set SHIPRIG_BIN to a shiprig >= 1.20.0 binary to run the tests " +
        "(e.g. `go build -o /tmp/shiprig ./cmd/shiprig` in a rigsmith checkout).",
    );
  }
}
