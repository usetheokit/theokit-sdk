# Error codes

Every `code` this SDK puts on a thrown or reported error, the class that carries it, and where it is raised. **Generated from the source AST** by `tools/generate-error-codes.mjs` — do not edit by hand.

Branch on `code`, never on the message: messages carry context (an id, a path, a limit) and change with it, while a code is the contract. `err.code === "context_too_long"` keeps working when the message gains a token count.

**Transport codes vs the rest.** `ErrorCode` in `errors.ts` is the small canonical union a provider failure maps onto — the codes marked *transport* below. Everything else is raised by a specific subsystem at a specific place, and a `catch` that only handles the union will meet them anyway.

243 distinct code(s).

| Code | Kind | Raised by | Sites |
|---|---|---|---|
| `a2a_peer_not_registered` | domain | A2APeerNotRegisteredError | `packages/sdk/src/a2a/message-bus.ts:28` +1 |
| `a2a_request_timeout` | domain | A2ARequestTimeoutError | `packages/sdk/src/a2a/message-bus.ts:62` +1 |
| `aborted` | domain | TheokitAgentError | `packages/sdk/src/internal/agent/batch.ts:358` +1 |
| `agent_disposed` | domain | — | `packages/sdk/src/errors.ts:544` |
| `agent_id_already_exists` | domain | ConfigurationError | `packages/sdk/src/internal/agent/helpers.ts:52` |
| `agent_not_registered` | domain | UnknownAgentError | `packages/sdk/src/internal/cron/run-job.ts:61` |
| `agent_rehydration_failed` | domain | UnknownAgentError | `packages/sdk/src/internal/agent/helpers.ts:334` +1 |
| `anthropic_auth_failed` | domain | AuthenticationError | `packages/sdk/src/internal/error-mappers/anthropic.ts:56` |
| `anthropic_rate_limit` | domain | RateLimitError | `packages/sdk/src/internal/error-mappers/anthropic.ts:59` |
| `anthropic_server_error` | domain | NetworkError | `packages/sdk/src/internal/error-mappers/anthropic.ts:71` |
| `anthropic_timeout` | domain | NetworkError | `packages/sdk/src/internal/error-mappers/anthropic.ts:68` |
| `anthropic_unknown` | domain | UnknownAgentError | `packages/sdk/src/internal/error-mappers/anthropic.ts:73` |
| `artifact_path_traversal` | domain | ConfigurationError | `packages/sdk/src/internal/cloud-agent/cloud-agent.ts:287` |
| `auth_failed` | domain | ConfigurationError, MemoryAdapterError | `packages/memory-honcho/src/adapter.ts:237` +10 |
| `auth_permission` | domain | — | `packages/sdk/src/internal/error-mappers/vertex.ts:49` |
| `auth_provider_not_found` | domain | — | `packages/sdk/src/server/auth/errors.ts:34` |
| `auth_secret_too_short` | domain | — | `packages/sdk/src/server/auth/oauth-transaction-store.ts:101` +1 |
| `auth_unauthenticated` | domain | — | `packages/sdk/src/internal/error-mappers/vertex.ts:48` |
| `authentication_error` | domain | AuthenticationError | `packages/sdk/src/theokit.ts:235` |
| `batch_task_cancelled` | domain | TheokitAgentError | `packages/sdk/src/internal/agent/batch.ts:130` |
| `batch_task_failed` | domain | TheokitAgentError | `packages/sdk/src/internal/agent/batch.ts:123` |
| `batch_task_no_terminal_event` | domain | TheokitAgentError | `packages/sdk/src/internal/agent/batch.ts:185` |
| `before_complete_failed` | domain | — | `packages/sdk/src/internal/local-agent/local-run.ts:111` |
| `budget_exceeded` | domain | — | `packages/sdk/src/errors.ts:515` +1 |
| `budget_op_unsupported` | domain | — | `packages/sdk/src/errors.ts:571` +1 |
| `catastrophic_command` | domain | — | `packages/sdk-tools/src/internal/shell-guard.ts:32` |
| `circuit_open` | domain | NetworkError | `packages/sdk/src/internal/llm/pool-aware-client.ts:106` |
| `cloud_custom_tools_rejected` | domain | ConfigurationError | `packages/sdk/src/internal/cloud-agent/cloud-agent.ts:150` +1 |
| `cloud_incompatible_function_resolver` | domain | ConfigurationError | `packages/sdk/src/internal/cloud-agent/cloud-tool-parity.ts:43` +2 |
| `cloud_incompatible_mcp_stdio_local` | domain | ConfigurationError | `packages/sdk/src/internal/cloud-agent/cloud-tool-parity.ts:74` |
| `cloud_plugin_path_rejected` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugins-manager.ts:159` +1 |
| `cloud_run_http_error` | domain | NetworkError | `packages/sdk/src/internal/cloud-agent/real-cloud-run.ts:155` |
| `cloud_run_unknown_status` | domain | NetworkError | `packages/sdk/src/internal/cloud-agent/real-cloud-run.ts:284` +1 |
| `cloud_runtime_pre_release` | domain | ConfigurationError | `packages/sdk/src/agent.ts:417` +2 |
| `cloud_stdio_cwd_rejected` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:121` |
| `compression_failed` | domain | — | `packages/sdk/src/internal/runtime/compression/compression-summarizer.ts:41` |
| `compression_model_unresolved` | domain | — | `packages/sdk/src/internal/runtime/compression/compression-model-registry.ts:102` +1 |
| `context_config_shape` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/context-manager.ts:256` |
| `context_frontmatter_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/context-frontmatter.ts:38` |
| `context_json_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/context-manager.ts:250` |
| `context_read_error` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/context-manager.ts:237` |
| `context_sources_shape` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/context-manager.ts:277` |
| `credential_pool_ambiguous` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:68` +1 |
| `credential_pool_empty` | domain | ConfigurationError | `packages/sdk/src/internal/llm/credential-pool.ts:91` |
| `cron_ambiguous_target` | domain | ConfigurationError | `packages/sdk/src/cron.ts:215` |
| `cron_missing_message` | domain | ConfigurationError | `packages/sdk/src/cron.ts:233` +1 |
| `cron_no_target` | domain | ConfigurationError | `packages/sdk/src/cron.ts:221` +1 |
| `cron_workflow_message` | domain | ConfigurationError | `packages/sdk/src/cron.ts:227` |
| `duplicate_skill_name` | domain | ConfigurationError | `packages/sdk/src/define-skill-read-tool.ts:155` |
| `duplicate_tool_name` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:201` |
| `effective_tools_expected_options` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/effective-tools.ts:102` +1 |
| `embedding_dimension_mismatch` | domain | ConfigurationError | `packages/sdk/src/internal/memory/lance-index.ts:146` +1 |
| `embedding_invalid_response` | domain | NetworkError | `packages/sdk/src/internal/memory/adapters/openai-compatible.ts:399` |
| `embedding_missing_api_key` | domain | AuthenticationError | `packages/sdk/src/internal/memory/adapters/openai-compatible.ts:141` |
| `embedding_unknown_model` | domain | ConfigurationError | `packages/sdk/src/internal/memory/adapters/openai-compatible.ts:153` |
| `eval_already_running` | domain | — | `packages/sdk/src/internal/eval/single-flight.ts:19` |
| `eval_threshold_failed` | domain | — | `packages/sdk/src/internal/eval/assert.ts:33` |
| `fallback_empty_chain` | domain | NetworkError | `packages/sdk/src/internal/llm/fallback-client.ts:44` |
| `filesystem_io` | domain | FilesystemError | `packages/sdk/src/filesystem/types.ts:96` +1 |
| `filesystem_not_found` | domain | FileNotFoundError | `packages/sdk/src/filesystem/types.ts:81` +1 |
| `filesystem_readonly` | domain | FilesystemReadOnlyError | `packages/sdk/src/filesystem/types.ts:71` +1 |
| `filesystem_security` | domain | FilesystemSecurityError | `packages/sdk/src/filesystem/types.ts:61` +1 |
| `filesystem_stale` | domain | StaleFileError | `packages/sdk/src/filesystem/types.ts:115` +2 |
| `forbidden_path` | domain | — | `packages/sdk/src/internal/security/path-guard.ts:57` +1 |
| `handoff_package_missing` | domain | ConfigurationError | `packages/sdk/src/internal/agent/helpers.ts:102` +1 |
| `handoff_target_invalid` | domain | ConfigurationError | `packages/sdk-handoff/src/handoff.ts:116` |
| `handoff_target_required` | domain | ConfigurationError | `packages/sdk-handoff/src/handoff.ts:111` |
| `hitl_timeout` | domain | HitlTimeoutError | `packages/sdk/src/internal/runtime/tools/hitl-middleware.ts:42` +1 |
| `hook_denied` | domain | ConfigurationError | `packages/sdk/src/internal/local-agent/local-agent.ts:454` |
| `hooks_invalid_command` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/hooks/hooks-source.ts:406` |
| `hooks_json_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/hooks/hooks-source.ts:252` +2 |
| `hooks_read_error` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/hooks/hooks-source.ts:243` |
| `hooks_unsupported_field` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/hooks/hooks-source.ts:384` |
| `hooks_unsupported_type` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/hooks/hooks-source.ts:400` |
| `interactive_unavailable` | domain | InteractiveUnavailableError | `packages/sdk/src/interactive/types.ts:28` +1 |
| `INTERNAL_SERVER_ERROR` | domain | — | `packages/sdk/src/server/errors-envelope.ts:100` |
| `invalid_argument` | domain | TheokitAgentError | `packages/sdk/src/compaction.ts:79` |
| `invalid_batch_item` | domain | ConfigurationError | `packages/sdk/src/internal/agent/batch.ts:67` |
| `invalid_batch_size` | domain | ConfigurationError | `packages/sdk/src/internal/memory/migrate-sqlite-to-lance.ts:128` |
| `invalid_budget_name` | domain | ConfigurationError | `packages/sdk/src/internal/budget/registry.ts:28` +5 |
| `invalid_categories` | domain | ConfigurationError | `packages/sdk-memory/src/internal/categorized-memory.ts:120` +3 |
| `invalid_concurrency` | domain | ConfigurationError | `packages/sdk/src/internal/agent/batch.ts:58` +1 |
| `invalid_context_window_margin` | domain | — | `packages/sdk/src/compaction.ts:278` +1 |
| `invalid_cron` | domain | ConfigurationError | `packages/sdk/src/internal/cron/validate.ts:35` +3 |
| `invalid_doom_loop_threshold` | domain | ConfigurationError | `packages/sdk/src/internal/agent-loop/doom-loop-tracker.ts:47` |
| `invalid_filename_id` | domain | ConfigurationError | `packages/sdk/src/internal/security/path-guard.ts:486` |
| `invalid_identifier` | domain | ConfigurationError | `packages/sdk/src/internal/security/path-guard.ts:434` +2 |
| `invalid_input` | domain | MemoryAdapterError | `packages/memory-honcho/src/adapter.ts:98` +9 |
| `invalid_max_iterations` | domain | ConfigurationError | `packages/sdk/src/internal/local-agent/real-local-run.ts:71` |
| `invalid_memory_backend` | domain | ConfigurationError | `packages/sdk/src/internal/memory/index-manager-dispatch.ts:24` +1 |
| `invalid_memory_directory` | domain | ConfigurationError | `packages/sdk/src/internal/memory/storage/memory-root.ts:151` |
| `invalid_memory_kind` | domain | ConfigurationError | `packages/sdk/src/internal/memory/storage/markdown-store.ts:206` |
| `invalid_model_selection` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/model-selection.ts:21` |
| `invalid_processor_options` | domain | ConfigurationError | `packages/sdk/src/built-in-processors.ts:86` |
| `invalid_redaction_pattern` | domain | ConfigurationError | `packages/sdk/src/security.ts:84` |
| `invalid_request` | domain | — | `packages/sdk/src/internal/error-mappers/vertex.ts:53` +1 |
| `invalid_retry_config` | domain | ConfigurationError | `packages/sdk/src/internal/retry/with-retry.ts:67` |
| `invalid_skill_spec` | domain | ConfigurationError | `packages/sdk/src/create-skill.ts:44` +1 |
| `invalid_squad` | domain | ConfigurationError | `packages/sdk/src/squad.ts:112` |
| `invalid_task_id` | domain | — | `packages/sdk/src/task-errors.ts:33` +1 |
| `invalid_timezone` | domain | ConfigurationError | `packages/sdk/src/internal/cron/validate.ts:135` |
| `invalid_workflow_step` | domain | ConfigurationError | `packages/sdk/src/workflow.ts:231` |
| `iteration_limit_reached` | domain | — | `packages/sdk/src/internal/agent-loop/loop-finalize.ts:51` |
| `jsonl_parse_failed` | domain | — | `packages/sdk/src/internal/persistence/jsonl.ts:37` |
| `judge_credential` | domain | — | `packages/sdk/src/internal/judge/judge-call.ts:72` +1 |
| `lance_backend_unavailable` | domain | ConfigurationError | `packages/sdk/src/internal/memory/lance-index.ts:105` +3 |
| `lance_requires_embedding` | domain | ConfigurationError | `packages/sdk/src/internal/memory/index-manager-dispatch.ts:39` +1 |
| `live_session_protected` | domain | — | `packages/sdk/src/internal/persistence/transcript-ops.ts:48` +1 |
| `local_provider_http_error` | domain | ConfigurationError | `packages/sdk/src/internal/catalog/local-models.ts:61` |
| `local_provider_unreachable` | domain | ConfigurationError | `packages/sdk/src/internal/catalog/local-models.ts:46` |
| `malformed_api_key` | domain | AuthenticationError | `packages/sdk/src/internal/agent/helpers.ts:224` +1 |
| `max_delegation_depth` | domain | MaxDelegationDepthError | `packages/sdk/src/a2a/subagent.ts:239` +1 |
| `mcp_buffer_overflow` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:332` |
| `mcp_closed` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:307` |
| `mcp_crashed` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:222` |
| `mcp_disconnected` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:235` +2 |
| `mcp_http_error` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:497` +1 |
| `mcp_not_init` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/client.ts:265` +2 |
| `mcp_timeout` | domain | NetworkError | `packages/sdk/src/internal/mcp/client.ts:69` |
| `memory_context_missing_user_id` | domain | ConfigurationError | `packages/sdk/src/internal/local-agent/local-agent-memory-direct.ts:128` |
| `memory_path_escapes_root` | domain | ConfigurationError | `packages/sdk/src/internal/memory/tools.ts:115` +1 |
| `memory_path_traversal` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:280` |
| `memory_threat_rejected` | domain | ConfigurationError | `packages/sdk/src/internal/memory/storage/markdown-store.ts:223` |
| `memory_tool_bad_args` | domain | ConfigurationError | `packages/sdk/src/internal/memory/tools.ts:138` +1 |
| `migration_destination_exists` | domain | ConfigurationError | `packages/sdk/src/internal/memory/migrate-sqlite-to-lance.ts:159` +1 |
| `missing_api_key` | domain | AuthenticationError, ConfigurationError | `packages/sdk/src/internal/agent/helpers.ts:215` +2 |
| `missing_credential` | domain | AuthenticationError | `packages/sdk/src/internal/providers/builtin/openai-chatgpt.ts:72` |
| `missing_frontmatter` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/skill-frontmatter.ts:88` |
| `missing_model` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:35` |
| `model_unavailable` | domain | buildErrorMetadata | `packages/sdk/src/internal/error-mappers/ollama.ts:75` +1 |
| `network` | domain | MemoryAdapterError, buildErrorMetadata | `packages/memory-honcho/src/adapter.ts:258` +5 |
| `network_error` | domain | NetworkError | `packages/sdk/src/internal/http.ts:98` |
| `no_api_key` | domain | ConfigurationError | `packages/sdk-tools/src/web-search-brave.ts:50` |
| `no_memory_adapter` | domain | ConfigurationError | `packages/sdk/src/internal/local-agent/local-agent-memory-direct.ts:141` +2 |
| `no_such_session` | domain | NoSuchSessionError | `packages/sdk/src/interactive/types.ts:41` +1 |
| `no_text_answer` | domain | — | `packages/sdk/src/errors.ts:653` |
| `no_tool_call` | domain | — | `packages/sdk/src/errors.ts:653` |
| `node_ws_invalid_raw` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/ws-adapter-node.ts:107` |
| `not_found` | domain | MemoryAdapterError | `packages/memory-honcho/src/adapter.ts:251` +2 |
| `oauth_bind_failed` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/oauth.ts:226` |
| `oauth_refresh_failed` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/oauth.ts:52` |
| `oauth_state_mismatch` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/oauth.ts:127` |
| `oauth_timeout` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/oauth.ts:216` +1 |
| `oauth_token_exchange_failed` | domain | ConfigurationError | `packages/sdk/src/internal/mcp/oauth.ts:148` |
| `ollama_image_unsupported` | domain | ConfigurationError | `packages/sdk/src/internal/llm/ollama-native.ts:323` |
| `ollama_model_loading` | domain | NetworkError | `packages/sdk/src/internal/error-mappers/ollama.ts:101` |
| `ollama_model_not_pulled` | domain | ConfigurationError | `packages/sdk/src/internal/error-mappers/ollama.ts:84` |
| `ollama_unreachable` | domain | ConfigurationError | `packages/sdk/src/internal/error-mappers/ollama.ts:55` +1 |
| `pagination_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/persistence/pagination.ts:34` |
| `parse_failed` | domain | — | `packages/sdk/src/errors.ts:653` |
| `path_traversal` | domain | — | `packages/sdk/src/internal/security/path-guard.ts:37` |
| `permission_enforcement_unavailable` | domain | ConfigurationError | `packages/acp/src/permission-plugin.ts:138` +1 |
| `permission_rule_invalid` | domain | ConfigurationError | `packages/sdk/src/permission-rules.ts:82` +2 |
| `personality_empty_body` | domain | ConfigurationError | `packages/sdk/src/internal/personality/registry.ts:117` |
| `personality_not_found` | domain | ConfigurationError | `packages/sdk/src/internal/personality/switch.ts:60` |
| `personality_reserved_name` | domain | ConfigurationError | `packages/sdk/src/internal/personality/registry.ts:110` |
| `pipeline_duplicate_provider` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/system-prompt/pipeline.ts:33` |
| `plugin_entry_missing` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugins-manager.ts:134` |
| `plugin_frontmatter_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugin-frontmatter.ts:39` |
| `plugin_late_register_kind` | domain | ConfigurationError | `packages/sdk/src/internal/plugins/manager.ts:103` |
| `plugin_manifest_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugins-manager.ts:185` |
| `plugin_manifest_shape` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugins-manager.ts:191` |
| `plugin_missing_manifest` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/plugin-loader/plugins-manager.ts:176` +2 |
| `programmatic_hooks_rejected` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:97` |
| `provider_unresolved` | domain | ConfigurationError | `packages/sdk/src/internal/llm/router.ts:99` +1 |
| `rate_limit` | domain | — | `packages/sdk/src/internal/error-mappers/vertex.ts:47` |
| `rate_limited` | domain | MemoryAdapterError | `packages/memory-honcho/src/adapter.ts:244` +3 |
| `redirect_blocked` | domain | — | `packages/sdk-tools/src/internal/network-guard.ts:38` |
| `repo_provision_failed` | domain | — | `packages/sdk/src/sandbox/provision.ts:33` |
| `reserved_env_prefix` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:108` |
| `run_cancelled` | domain | — | `packages/sdk/src/errors.ts:653` |
| `run_not_found` | domain | UnknownAgentError | `packages/sdk/src/agent.ts:424` |
| `runtime_exclusive` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:88` |
| `sandbox_derived_helper_failed` | domain | ConfigurationError | `packages/sdk/src/sandbox/types.ts:185` +1 |
| `sandbox_not_available` | domain | SandboxNotAvailableError | `packages/sdk/src/sandbox/types.ts:92` +1 |
| `sandbox_security` | domain | SandboxSecurityError | `packages/sdk/src/sandbox/types.ts:73` +1 |
| `schema_invalid` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/skill-frontmatter.ts:99` +5 |
| `server_error` | domain | buildErrorMetadata | `packages/sdk/src/internal/error-mappers/ollama.ts:92` +1 |
| `session_busy` | domain | — | `packages/sdk/src/internal/persistence/session-writer.ts:56` +1 |
| `sql_injection_blocked` | domain | ConfigurationError | `packages/sdk/src/internal/memory/lance-index.ts:256` +3 |
| `sqlite_driver_unavailable` | domain | ConfigurationError | `packages/sdk/src/internal/persistence/sqlite-open.ts:195` |
| `sqlite_vec_unavailable` | domain | ConfigurationError | `packages/sdk/src/internal/memory/sqlite-vec-loader.ts:23` +1 |
| `squad_process_unsupported` | domain | ConfigurationError | `packages/sdk/src/squad.ts:117` |
| `sse_http_error` | domain | SubscriptionError | `packages/sdk/src/subscription/theokit-subscribe.ts:146` |
| `sse_server_error` | domain | SubscriptionError | `packages/sdk/src/subscription/theokit-subscribe.ts:154` |
| `ssrf_blocked` | domain | — | `packages/sdk-tools/src/internal/network-guard.ts:23` |
| `stream_idle_timeout` | domain | NetworkError | `packages/sdk/src/internal/llm/sse.ts:95` |
| `stream_truncated` | domain | NetworkError | `packages/sdk/src/internal/llm/anthropic.ts:184` +1 |
| `subagent_mcp_unsupported_local` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/subagents-loader.ts:207` |
| `subagent_missing_description` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:142` |
| `subagent_missing_frontmatter` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/subagents-loader.ts:284` |
| `subagent_missing_prompt` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:147` |
| `subagent_reasoning_effort_without_model` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/subagents-loader.ts:227` |
| `subagent_sandbox_not_boolean` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/subagents-loader.ts:247` |
| `subagent_unknown_field` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/skills/subagents-loader.ts:192` |
| `subagent_unknown_setting_source` | domain | ConfigurationError | `packages/sdk/src/subagents-loader.ts:96` |
| `subscribe_baseUrl_missing` | domain | SubscriptionError | `packages/sdk/src/subscription/theokit-subscribe.ts:77` |
| `subscribe_name_invalid` | domain | SubscriptionError | `packages/sdk/src/subscription/theokit-subscribe.ts:72` |
| `subscription_descriptor_invalid` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/server-integration.ts:172` |
| `subscription_disconnected` | domain | — | `packages/sdk/src/subscription/types.ts:147` |
| `subscription_duplicate` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/subscription-runtime.ts:101` |
| `subscription_input_invalid` | domain | — | `packages/sdk/src/subscription/types.ts:126` |
| `subscription_not_found` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/subscription-runtime.ts:130` |
| `task_not_found` | domain | — | `packages/sdk/src/task-errors.ts:53` +1 |
| `task_op_unsupported` | domain | — | `packages/sdk/src/task-errors.ts:73` +1 |
| `timeout` | domain | — | `packages/sdk/src/internal/error-mappers/vertex.ts:55` |
| `tool_invalid_name` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:239` |
| `tool_invalid_schema_type` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:268` |
| `tool_missing_description` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:254` |
| `tool_missing_handler` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:226` |
| `tool_missing_name` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:234` |
| `tool_missing_schema` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:263` |
| `tool_reserved_name` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/validation/validate-agent-options.ts:245` |
| `transport_failure` | domain | NetworkError | `packages/sdk/src/internal/llm/transport-error.ts:48` |
| `transport_unavailable` | domain | ConfigurationError | `packages/sdk/src/internal/llm/router.ts:525` +1 |
| `unimplemented_budget_scope` | domain | ConfigurationError | `packages/sdk/src/internal/budget/registry.ts:58` +1 |
| `unknown` | domain | AgentRunError, MemoryAdapterError, TheokitAgentError | `packages/memory-honcho/src/adapter.ts:264` +5 |
| `unknown_agent` | domain | UnknownAgentError | `packages/sdk/src/agent.ts:207` +1 |
| `unknown_artifact` | domain | UnknownAgentError | `packages/sdk/src/internal/cloud-agent/cloud-agent.ts:306` |
| `unknown_category` | domain | ConfigurationError | `packages/sdk-memory/src/internal/categorized-memory.ts:76` |
| `unknown_cron_job` | domain | UnknownAgentError | `packages/sdk/src/cron.ts:80` +2 |
| `unsafe_filename` | domain | ConfigurationError | `packages/sdk/src/internal/runtime/context/project-instructions.ts:120` |
| `unsupported_schema` | domain | ConfigurationError | `packages/sdk/src/schema-normalizer.ts:110` +1 |
| `upstream_run_failed` | domain | — | `packages/sdk/src/errors.ts:653` |
| `valibot_converter_missing` | domain | ConfigurationError | `packages/sdk/src/schema-normalizer.ts:81` +1 |
| `work_threw` | domain | — | `packages/sdk/src/internal/task/registry.ts:295` |
| `workflow_already_committed` | domain | ConfigurationError | `packages/sdk/src/workflow.ts:269` |
| `workflow_already_running` | domain | — | `packages/sdk/src/workflow-errors.ts:141` |
| `workflow_compensate_not_implemented` | domain | — | `packages/sdk/src/workflow-errors.ts:246` +1 |
| `workflow_duplicate_step_id` | domain | — | `packages/sdk/src/workflow-errors.ts:31` |
| `workflow_input_invalid` | domain | — | `packages/sdk/src/workflow-errors.ts:48` |
| `workflow_max_iterations_exceeded` | domain | — | `packages/sdk/src/workflow-errors.ts:181` |
| `workflow_nested_failed` | domain | — | `packages/sdk/src/workflow-errors.ts:103` +1 |
| `workflow_not_serializable` | domain | — | `packages/sdk/src/workflow-errors.ts:195` +1 |
| `workflow_output_invalid` | domain | — | `packages/sdk/src/workflow-errors.ts:65` |
| `workflow_resume_step_not_found` | domain | — | `packages/sdk/src/workflow-errors.ts:210` +1 |
| `workflow_snapshot_not_found` | domain | — | `packages/sdk/src/workflow-errors.ts:159` |
| `workflow_state_invalid` | domain | — | `packages/sdk/src/workflow-errors.ts:82` |
| `workflow_tool_failed` | domain | WorkflowToolError | `packages/sdk/src/workflow-as-tool.ts:40` +2 |
| `ws_global_missing` | domain | SubscriptionError | `packages/sdk/src/subscription/theokit-subscribe.ts:183` |
| `ws_peer_missing` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/ws-adapter-node.ts:48` |
| `ws_transport_mismatch` | domain | SubscriptionError | `packages/sdk/src/subscription/internal/server-integration.ts:351` |
| `zod_not_installed` | domain | ConfigurationError | `packages/sdk/src/internal/structured-output-helpers.ts:33` +1 |

