// @va/core public surface. Test helpers (fakes, fixtures, harness) are exported from
// `@va/core/test`.
export { authenticateToken, isAuthError } from './auth.js'
export type { AuthContext, AuthError, AuthResult, Language, Role } from './auth.js'
export { CALLS_PER_DAY, checkCallLimits, CONCURRENT_CALLS, SPOKEN_CHANNELS } from './call-limits.js'
export type { CallLimitVerdict } from './call-limits.js'
export { CHANNEL_DEFAULTS, channelSettings } from './channel.js'
export type { Channel, ChannelSettings, Effort } from './channel.js'
export { MESSAGES_HR, mapAnthropicError } from './errors.js'
export type { ErrorCode, MappedError } from './errors.js'
export { errorReason, log, REASON_MAX_CHARS } from './log.js'
export type { LogLevel } from './log.js'
export {
  CONFIRMATION_TTL_MS,
  inputHash,
  MemoryConfirmationStore,
  pendingResult,
  stableStringify,
} from './loop/confirmations.js'
export { dispatchTool, dispatchToolWithTimeout } from './loop/dispatch.js'
export type { DispatchContext, DispatchResult, ToolOutcome } from './loop/dispatch.js'
export { applyMessageCacheBreakpoint, assembleHistory, withoutToolBlocks } from './loop/history.js'
export type { AssembleOptions, HistoryRow } from './loop/history.js'
export { runOrchestrationLoop, TRUNCATED_HR } from './loop/orchestrator.js'
export type {
  ConfirmEvent,
  ConfirmationStore,
  ConsumeMatch,
  ConsumeResult,
  ContentBlock,
  EventSink,
  InMemoryMessage,
  LoopConfig,
  LoopHooks,
  LoopInput,
  LoopMark,
  MessageRow,
  MessageStore,
  PendingConfirmation,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
  UsageReport,
} from './loop/ports.js'
export { FALLBACK_BETA, modelProfile } from './model.js'
export type { ModelExtra, ModelProfile } from './model.js'
export { buildStaticSystemPrompt, buildUserContext, dateLine, DOMAIN_RULES_HR } from './prompts/index.js'
export { BufferedSink } from './sinks/buffered.js'
export { speakable } from './sinks/speakable.js'
export {
  COURTESY_HR,
  COURTESY_MAX_WORDS,
  EARLY_FILLERS_HR,
  FILLER_AFTER_MS,
  FILLERS_HR,
  HOLD_MS,
  isCourtesy,
  SpokenTextSink,
} from './sinks/spoken.js'
export type { SpokenEnd, SpokenSinkOptions } from './sinks/spoken.js'
export { defineTool } from './tools/define.js'
export type { ToolDefinition, ToolHandlerExtras, ToolPack } from './tools/define.js'
export { ToolRegistry } from './tools/registry.js'
export type { AllowedTools, ChannelAllowlist, RefusalReason } from './tools/registry.js'
export { toAnthropicTool } from './tools/schema.js'
