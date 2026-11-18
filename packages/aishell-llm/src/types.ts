/**
 * OpenAI-compatible chat-completions wire format.
 *
 * @module @huaweidevtools/aishell-dsh-llm/types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** One message's content: plain text, or an ordered part list when it carries an image. */
export type WireContent = string | WireContentPart[]

/**
 * One content part. Only the two shapes this adapter emits are declared: text,
 * and the base64 data URL an OpenAI-compatible endpoint reads an image from.
 * The harness's `reasoning` blocks fold into text; `file` blocks are projected
 * to handle text by request assembly before any adapter sees them.
 */
export type WireContentPart = WireTextPart | WireImageUrlPart

export interface WireTextPart {
  type: 'text'
  text: string
}

export interface WireImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

/** One wire message. */
export type WireMessage = WireSystemMessage | WireUserMessage | WireAssistantMessage | WireToolMessage

export interface WireSystemMessage {
  role: 'system'
  content: string
}

export interface WireUserMessage {
  role: 'user'
  content: WireContent
}

export interface WireAssistantMessage {
  role: 'assistant'
  content?: string | null
  tool_calls?: WireAssistantToolCall[]
}

export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  /**
   * Always a string, even when the tool result carried an image. OpenAI's
   * tool message takes text only; an image from a tool result is hoisted into
   * a separate `user` turn instead, which is what the one OpenAI-path
   * serializer in the ecosystem does. Widening this field would produce a
   * request that some gateways reject with 400 and others silently drop.
   */
  content: string
}

export interface WireAssistantToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One SSE chunk from the chat-completions stream. */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
}

/** One model entry from the GET /models response (OpenAI-compatible). */
export interface WireModel {
  id: string
  /**
   * Display name, when the gateway sends one. Outside OpenAI's own model
   * object (which carries `id` alone), so it is an extension like the
   * metadata below, and the gateway omits it for a model that declares none.
   *
   * This is the field that lets an id stay a durable routing key while the
   * label a person reads stays free to change — the split every official
   * adapter's `name ?? id` expresses. Without it the two roles collapse onto
   * the id, and a reserved name like `trial` has to read well in a picker.
   */
  name?: string
  object?: string
  owned_by?: string
  created?: number
  /**
   * The gateway's request-modality list (`["text","image"]`) — the catalog's
   * own answer to "what does this model accept", and the only field this
   * adapter reads for capability. A sibling `capabilities` object is not
   * declared: the gateway may send one, and its `image: boolean` reads like a
   * fallback for an absent `modalities`, but nothing here consumes it, so
   * declaring it would only suggest a fallback that does not exist.
   */
  modalities?: string[]
  reasoning_effort?: string[]
  limits?: WireModelLimits
  pricing?: WireModelPricing
}

/**
 * The gateway's token limits for one model.
 *
 * Declared in full because they are part of the gateway's documented `/models`
 * shape, and dropping them would make this type describe a response the gateway
 * does not send.
 *
 * `context_window` anchors everything: compaction prices a route against it,
 * and the request's output budget is derived from it (see `outputCapFor` in
 * `./adapter.ts`).
 *
 * The other two are advisory. The gateway is a reverse proxy and enforces
 * neither, so both are clamped against the window before use — a declared value
 * above what the window leaves would otherwise produce a route that cannot
 * compact.
 */
export interface WireModelLimits {
  /** Total tokens one request may occupy, prompt and completion together. */
  context_window?: number
  /**
   * Advertised prompt ceiling. Not read: no part of the harness enforces one,
   * and compaction already bounds the prompt from `context_window`.
   */
  max_prompt_tokens?: number
  /**
   * Advertised completion ceiling. Preferred over the window share when
   * declared, then clamped so the route stays compactable.
   */
  max_completion_tokens?: number
}

export interface WireModelPricing {
  currency?: string
  unit?: string
  input?: number
  cached_input?: number
  output?: number
}

/** Response body from GET /models. */
export interface WireModelList {
  data: WireModel[]
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireDelta {
  role?: string
  content?: string
  reasoning_content?: string
  tool_calls?: WireDeltaToolCall[]
}

export interface WireDeltaToolCall {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}
