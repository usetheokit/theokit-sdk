---
'@theokit/sdk': patch
---

A local run cancelled while its MCP servers start up no longer starts the MCP servers after the one whose handshake was in progress. Until now every remaining server was still initialized, and each stdio server spawned its child process, after the cancel. The handshake already in progress still finishes, and the run still closes every MCP client it owns.
