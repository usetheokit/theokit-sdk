---
'@theokit/sdk': patch
---

The `thinking-completed` update now arrives when the reasoning ends: before the first `text-delta`
of a turn that reasons and then answers. It used to arrive after the whole turn's stream, so a UI
that closed its reasoning block on it kept the block open until the answer had finished.

`thinkingDurationMs` on that update, and `thinking_duration_ms` on the replayed `thinking` message,
are now the reasoning span: the time of the last reasoning delta minus the time of the first. They
used to run until the end of the stream and so included the answer. In a live OpenRouter recording
the reported value was 19076 ms for 8282 ms of reasoning. Reasoning that arrives in a single delta,
with no delta after it, reports 0.

A turn that reasons and then calls a tool, or that ends without text, still sends the update at the
end of the stream, with the same duration rule. Each turn with reasoning still sends exactly one
`thinking-completed`; reasoning that arrives after the answer started is shown and replayed but
sends no second one.
