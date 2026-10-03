import { Model, Provider } from "@opencode/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { DiscoveredModel } from "./models"
import type { ProviderOptions } from "./options"
import type { MtlsBridge } from "./transport"

export function usesResponses(config: ProviderOptions, discovered: DiscoveredModel[]) {
  if (config.protocol === "responses") return true
  if (config.protocol === "chat-completions") return false
  return discovered.some((model) => model.protocol === "responses")
}

export function applyProvider(
  editor: ProviderEditor,
  id: string,
  config: ProviderOptions,
  discovered: DiscoveredModel[],
  bridge: Pick<MtlsBridge, "baseURL" | "headers">,
) {
  const records = editor.list()
  const responses = usesResponses(config, discovered)
  const providerID = Provider.ID.make(id)
  const packageName = nativePackage(config.package, responses)
  const settings = {
    ...(config.settings ?? {}),
    baseURL: bridge.baseURL,
    transport: "http",
    ...(!responses ? { provider: id } : {}),
  } as Record<string, unknown>

  const models = unique(discovered).map((model) => {
    const template =
      records
        .map((record) => record.models.get(model.baseModelID ?? model.id))
        .find((item) => item !== undefined) ??
      records.map((record) => record.models.get(model.id)).find((item) => item !== undefined)

    const modelID = Model.ID.make(model.id)
    const base = Model.Info.default(providerID, modelID)
    return {
      ...base,
      modelID,
      name: model.name ?? template?.name ?? model.id,
      ...(template?.family ? { family: template.family } : {}),
      capabilities: {
        tools: model.supportsTools ?? template?.capabilities.tools ?? true,
        input: [...(model.inputModalities ?? template?.capabilities.input ?? ["text"])],
        output: [...(model.outputModalities ?? template?.capabilities.output ?? ["text"])],
      },
      variants:
        model.reasoningSupported?.map((effort) => ({
          id: Model.VariantID.make(effort),
          settings: { reasoningEffort: effort },
        })) ??
        template?.variants.map((variant) => ({
          id: variant.id,
          ...(variant.settings ? { settings: { ...variant.settings } } : {}),
          ...(variant.headers ? { headers: { ...variant.headers } } : {}),
          ...(variant.body ? { body: { ...variant.body } } : {}),
        })) ??
        [],
      time: { released: released(model.created, template?.time.released) },
      cost:
        template?.cost.map((cost) => ({
          ...(cost.tier ? { tier: { ...cost.tier } } : {}),
          input: cost.input,
          output: cost.output,
          cache: { ...cost.cache },
        })) ?? [],
      status: model.status ?? template?.status ?? "active",
      enabled: true,
      limit: {
        // codex-proxy manages the upstream model's lower soft compaction
        // threshold. Give OpenCode the backend's hard window so its local
        // compactor does not race the encrypted Codex compaction path.
        context: model.maxContextLength ?? model.contextLength ?? template?.limit.context ?? 0,
        input: model.maxInputLength ?? template?.limit.input,
        output: model.maxOutputLength ?? template?.limit.output ?? 0,
      },
      ...(model.reasoningDefault || model.reasoningSupported?.length
        ? {
            settings: {
              reasoningSummary: "auto",
              ...(model.reasoningDefault ? { reasoningEffort: model.reasoningDefault } : {}),
            },
          }
        : {}),
    } satisfies Model.Info
  })

  const info = {
    ...Provider.Info.empty(providerID),
    name: config.name ?? id,
    activation: "enabled" as const,
    package: packageName,
    settings,
    headers: { ...bridge.headers },
  } satisfies Provider.Info

  if (editor.get(id)) {
    editor.update(id, (provider) => {
      provider.name = info.name
      provider.activation = info.activation
      provider.package = info.package
      provider.settings = { ...settings }
      provider.headers = { ...bridge.headers }
    })
    editor.models.set(id, models)
    return
  }

  editor.add({ info, models })
}

function nativePackage(input: string | undefined, responses: boolean) {
  if (!input) {
    return responses
      ? "@opencode/ai/providers/openai/responses"
      : "@opencode/ai/providers/openai-compatible"
  }

  if (input === "@ai-sdk/openai" || input === "aisdk:@ai-sdk/openai") {
    return "@opencode/ai/providers/openai/responses"
  }
  if (input === "@ai-sdk/openai-compatible" || input === "aisdk:@ai-sdk/openai-compatible") {
    return "@opencode/ai/providers/openai-compatible"
  }
  if (input.startsWith("aisdk:") || input.startsWith("@ai-sdk/")) {
    throw new Error(
      `AI SDK provider package overrides are not supported by the native mTLS bridge: ${input}`,
    )
  }
  return input
}

function unique(input: DiscoveredModel[]) {
  return [...new Map(input.map((model) => [model.id, model])).values()]
}

function released(input: number | undefined, fallback = 0) {
  if (input === undefined) return fallback
  return input < 1_000_000_000_000 ? input * 1000 : input
}
