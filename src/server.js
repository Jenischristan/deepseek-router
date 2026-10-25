// Compatibility shim: the server was split into ./http.js and ./openai/*.js.
// Existing imports keep working.
export { createServer } from './http.js';
export {
  MODELS,
  resolveModel,
  makeId,
  contentToText,
  buildSeedPrompt,
  estimateTokens,
  openaiError,
  completionResponse,
  chunk,
  usageChunk,
} from './openai/models.js';
export { consumeDeepSeekStream, fragmentsText } from './openai/sse.js';
export {
  makeToolCallId,
  stableStringify,
  messageContentText,
  normalizeTools,
  normalizeToolChoice,
  toolChoiceMode,
  toolSignature,
} from './openai/json.js';
export {
  normalizeIdentifier,
  alignArguments,
  validateArguments,
  rankToolNames,
  resolveToolName,
} from './openai/schema.js';
export { sanitizeToolCalls, validateToolCalls } from './openai/sanitize.js';
export {
  parseToolResponse,
  interpretToolResponse,
  describeInvalidCall,
  buildToolRepairPrompt,
} from './openai/parse.js';
export {
  formatToolSignatures,
  formatToolReminder,
  buildToolInstructions,
} from './openai/prompt.js';
export {
  formatToolCallsForTranscript,
  toolCallMapping,
  formatToolResultBlock,
  formatToolResultPrompt,
  normalizeMessagesForCache,
} from './openai/transcript.js';
export { splitAtToolMarker, ToolCallStreamFilter } from './openai/filter.js';
