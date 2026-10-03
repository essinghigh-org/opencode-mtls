export type DiscoveredModel = {
  id: string
  name?: string
  baseModelID?: string
  created?: number
  contextLength?: number
  maxContextLength?: number
  maxInputLength?: number
  maxOutputLength?: number
  inputModalities?: string[]
  outputModalities?: string[]
  supportsTools?: boolean
  protocol?: "responses" | "chat-completions"
  reasoningDefault?: string
  reasoningSupported?: string[]
  status?: "alpha" | "beta" | "deprecated" | "active"
}

export async function discoverModels(baseURL: string, transport: typeof fetch) {
  const endpoint = new URL("models", baseURL.endsWith("/") ? baseURL : `${baseURL}/`)
  const response = await transport(endpoint, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`failed to discover models from ${endpoint}: HTTP ${response.status}`)
  }

  const body: unknown = await response.json()
  const values: unknown[] | undefined = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "data" in body && Array.isArray(body.data)
      ? body.data
      : undefined

  if (!values) throw new Error(`invalid model response from ${endpoint}: expected an array or { data: [] }`)

  return values.flatMap((input): DiscoveredModel[] => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return []
    const item = input as Record<string, unknown>
    if (typeof item.id !== "string" || !item.id.trim()) return []

    const reasoning = record(item.reasoning)
    const api = optionalString(item.api) ?? optionalString(item.protocol)

    return [
      {
        id: item.id,
        name: optionalString(item.name),
        baseModelID: optionalString(item.base_model_id) ?? optionalString(item.hugging_face_id),
        created: finite(item.created),
        contextLength: finite(item.context_length),
        maxContextLength: finite(item.max_context_length),
        maxInputLength: finite(item.max_input_length),
        maxOutputLength: finite(item.max_output_length),
        inputModalities: strings(item.input_modalities),
        outputModalities: strings(item.output_modalities),
        supportsTools: feature(item.supported_features, "tools"),
        protocol: api === "responses" || api === "openai/responses" ? "responses" : api === "chat-completions" ? api : undefined,
        reasoningDefault: optionalString(reasoning?.default),
        reasoningSupported: strings(reasoning?.supported),
        status: status(item.status),
      },
    ]
  })
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function optionalString(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function finite(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function strings(input: unknown) {
  if (!Array.isArray(input) || !input.every((item) => typeof item === "string")) return
  return input as string[]
}

function feature(input: unknown, value: string) {
  const list = strings(input)
  return list ? list.includes(value) : undefined
}

function status(input: unknown): DiscoveredModel["status"] {
  return input === "alpha" || input === "beta" || input === "deprecated" || input === "active" ? input : undefined
}
