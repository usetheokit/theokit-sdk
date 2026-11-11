---
'@theokit/sdk': minor
---

`decide`: a typed decision (one label from a declared enum) answered by a pinned local ONNX classifier. The model file's SHA-256 is verified before it loads (`DecisionChecksumError` on mismatch) and no provider request is made. Needs the optional `onnxruntime-node`.
