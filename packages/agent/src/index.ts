export { Agent } from './agent.js';
export type {
  AgentDeps,
  AskOptions,
  AnswerEnvelope,
  ToolCallTrace,
  AgentEvent,
} from './agent.js';
export { makeStreamingAgent } from './agent.stream.js';
export type { StreamingAgent } from './agent.stream.js';
export {
  sanitiseForLlm,
  wrapUntrusted,
  stripDangerous,
  HIGH_RISK_TOOLS,
  UNTRUSTED_GUARDRAIL,
  SNIPPET_BYTE_CAP,
} from './sanitiser.js';
export {
  loadSession,
  saveSession,
  enforceByteCap,
  readMaxTurns,
  SESSION_DEFAULT_MAX_TURNS,
  SESSION_MAX_BYTES,
} from './session.js';
export type { SessionState, SessionMetadata, SessionRepoLike } from './session.js';

export {
  getAgentProvider,
  readAgentEnv,
  AGENT_DEFAULT_MAX_TOKENS,
  AGENT_DEFAULT_TOOL_ITERATIONS,
} from './factory.js';
export type { AgentEnv } from './factory.js';

export type {
  LlmProvider,
  LlmProviderId,
  CompletionRequest,
  CompletionResponse,
  CompletionDelta,
  Message,
  ToolCall,
  ToolSpec,
  StopReason,
} from './provider.interface.js';

export { OpenAIProvider } from './openai.provider.js';
export { AnthropicProvider } from './anthropic.provider.js';
export { OllamaProvider } from './ollama.provider.js';

export {
  answerSchema,
  validateAnswer,
  extractJson,
} from './answer.contract.js';
export type {
  Answer,
  Citation,
  ValidationResult,
  ValidateOptions,
} from './answer.contract.js';

export { ToolRegistry } from './tools/registry.js';
export type { RegistryInvokeResult } from './tools/registry.js';
export type { AgentTool, ToolInvocationResult, SeenIds } from './tools/tool.interface.js';
export { SeenIdSet } from './tools/tool.interface.js';

export { buildGraphCypherTool, isReadOnlyCypher } from './tools/graph.cypher.tool.js';
export { buildFindTableTool } from './tools/graph.find_table.tool.js';
export { buildFindFunctionTool } from './tools/graph.find_function.tool.js';
export { buildSemanticRetrieveTool } from './tools/retrieve.semantic.tool.js';
export { buildCodeReadTool, resolveSafe, MAX_LINES as CODE_READ_MAX_LINES } from './tools/code.read.tool.js';
export { buildGitBlameTool } from './tools/git.blame.tool.js';
export { buildRouteClassifyTool } from './tools/route.classify.tool.js';

export { buildSystemPrompt } from './prompts/loader.js';
