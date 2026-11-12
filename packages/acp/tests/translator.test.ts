/**
 * T3.2 — translator tests.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@theokit/sdk";
import { describe, expect, it, vi } from "vitest";
import { toolKind, translateStream } from "../src/translator.js";

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void> {
  for (const item of items) yield item;
}

function makeConn(): { conn: acp.AgentSideConnection; updates: acp.SessionNotification[] } {
  const updates: acp.SessionNotification[] = [];
  const conn = {
    sessionUpdate: vi.fn(async (params: acp.SessionNotification) => {
      updates.push(params);
    }),
  } as unknown as acp.AgentSideConnection;
  return { conn, updates };
}

describe("toolKind", () => {
  it("tool_kind_read_file_returns_read", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("list_dir")).toBe("read");
    expect(toolKind("git_diff")).toBe("read");
    expect(toolKind("search_text")).toBe("read");
  });

  it("tool_kind_write_file_returns_edit", () => {
    expect(toolKind("write_file")).toBe("edit");
    expect(toolKind("apply_patch")).toBe("edit");
  });

  it("tool_kind_unknown_returns_other", () => {
    expect(toolKind("random_tool")).toBe("other");
    expect(toolKind("custom_thing")).toBe("other");
  });

  it("tool_kind_fetch_kind", () => {
    expect(toolKind("web_search")).toBe("fetch");
    expect(toolKind("fetch_url")).toBe("fetch");
  });

  it("tool_kind_execute_kind", () => {
    expect(toolKind("run_command")).toBe("execute");
    expect(toolKind("run_vitest")).toBe("execute");
  });
});

describe("translateStream", () => {
  it("translate_assistant_text_emits_agent_message_chunk", async () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        agent_id: "a-1",
        run_id: "r-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        },
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
  });

  it("translate_assistant_tool_use_emits_tool_call_kind", async () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        agent_id: "a-1",
        run_id: "r-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-1", name: "read_file", input: {} }],
        },
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe("tool_call");
    if (updates[0]?.update.sessionUpdate === "tool_call") {
      expect(updates[0].update.kind).toBe("read");
      expect(updates[0].update.toolCallId).toBe("t-1");
    }
  });

  it("translate_tool_call_running_to_completed_emits_updates", async () => {
    const messages: SDKMessage[] = [
      {
        type: "tool_call",
        agent_id: "a-1",
        run_id: "r-1",
        call_id: "t-1",
        name: "read_file",
        status: "running",
      },
      {
        type: "tool_call",
        agent_id: "a-1",
        run_id: "r-1",
        call_id: "t-1",
        name: "read_file",
        status: "completed",
        result: "content here",
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]?.update.sessionUpdate).toBe("tool_call_update");
    expect(updates[1]?.update.sessionUpdate).toBe("tool_call_update");
    if (updates[1]?.update.sessionUpdate === "tool_call_update") {
      expect(updates[1].update.status).toBe("completed");
    }
  });

  it("translate_failed_tool_call_emits_failed_status", async () => {
    const messages: SDKMessage[] = [
      {
        type: "tool_call",
        agent_id: "a-1",
        run_id: "r-1",
        call_id: "t-1",
        name: "read_file",
        status: "error",
        result: { stdout: "", stderr: "boom", exitCode: 1 },
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe("tool_call_update");
    if (updates[0]?.update.sessionUpdate === "tool_call_update") {
      expect(updates[0].update.status).toBe("failed");
    }
  });

  it("translate_skips_system_and_user_echo", async () => {
    const messages: SDKMessage[] = [
      { type: "system", agent_id: "a-1", run_id: "r-1" },
      {
        type: "user",
        agent_id: "a-1",
        run_id: "r-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(0);
  });

  it("translate_thinking_emits_agent_thought_chunk", async () => {
    const messages: SDKMessage[] = [
      { type: "thinking", agent_id: "a-1", run_id: "r-1", text: "let me think" },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe("agent_thought_chunk");
  });

  it("translate_thinking_suppressed_when_option_set", async () => {
    const messages: SDKMessage[] = [
      { type: "thinking", agent_id: "a-1", run_id: "r-1", text: "private" },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
      suppressThinking: true,
    });
    expect(updates).toHaveLength(0);
  });

  it("translate_object_delta_skipped_in_v1", async () => {
    const messages: SDKMessage[] = [
      {
        type: "object_delta",
        agent_id: "a-1",
        run_id: "r-1",
        partial: { foo: "bar" },
        attempt: 1,
      },
    ];
    const { conn, updates } = makeConn();
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(0);
  });

  it("translate_abort_signal_mid_stream_stops_translation", async () => {
    const controller = new AbortController();
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "assistant",
        agent_id: "a-1",
        run_id: "r-1",
        message: { role: "assistant", content: [{ type: "text", text: "1" }] },
      };
      controller.abort();
      yield {
        type: "assistant",
        agent_id: "a-1",
        run_id: "r-1",
        message: { role: "assistant", content: [{ type: "text", text: "2" }] },
      };
    }
    const { conn, updates } = makeConn();
    await translateStream({
      messages: gen(),
      conn,
      sessionId: "s-1",
      signal: controller.signal,
      log: vi.fn(),
    });
    expect(updates).toHaveLength(1);
  });

  it("translate_session_update_throw_logged_continues_drain", async () => {
    const messages: SDKMessage[] = Array.from({ length: 3 }, () => ({
      type: "assistant" as const,
      agent_id: "a-1",
      run_id: "r-1",
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "x" }] },
    }));
    const log = vi.fn();
    const conn = {
      sessionUpdate: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as acp.AgentSideConnection;
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log,
    });
    // log called for each failure
    expect(log).toHaveBeenCalled();
  });

  it("translator_aborts_after_n_consecutive_send_failures (EC-10)", async () => {
    const messages: SDKMessage[] = Array.from({ length: 100 }, () => ({
      type: "assistant" as const,
      agent_id: "a-1",
      run_id: "r-1",
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "x" }] },
    }));
    const log = vi.fn();
    const sessionUpdate = vi.fn().mockRejectedValue(new Error("network down"));
    const conn = {
      sessionUpdate,
    } as unknown as acp.AgentSideConnection;
    await translateStream({
      messages: fromArray(messages),
      conn,
      sessionId: "s-1",
      signal: new AbortController().signal,
      log,
    });
    // Should bail after ~10 failures, not call 100 times.
    expect(sessionUpdate.mock.calls.length).toBeLessThanOrEqual(11);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/translator bailing/));
  });
});
