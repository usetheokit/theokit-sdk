// One implementation, shared with the SDK (#1068). `Memory.openIndex` opens the index through this
// package whenever it is installed, so a second copy here is the copy that runs. The one that used
// to live in this file answered a failed FTS query with `[]`; the SDK's falls back to a LIKE scan.
export { IndexManager } from "@theokit/sdk/internal/memory-store";
