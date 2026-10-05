import { describe, expect, test } from "bun:test"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { applyProvider, usesResponses } from "../src/catalog"

describe("applyProvider", () => {
  test("registers an OpenCode-native Responses provider through the mTLS bridge", () => {
    const records = new Map<string, any>()
    const editor: ProviderEditor = {
      list: () => [...records.values()],
      get: (id) => records.get(id),
      add: (definition) => {
        records.set(definition.info.id, {
          provider: definition.info,
          models: new Map(definition.models.map((model) => [model.id, model])),
        })
      },
      update: (id, update) => {
        const record = records.get(id)
        if (!record) throw new Error(`missing provider ${id}`)
        update(record.provider)
      },
      remove: (id) => {
        records.delete(id)
      },
      models: {
        set: (id, models) => {
          const record = records.get(id)
          if (!record) throw new Error(`missing provider ${id}`)
          record.models = new Map(models.map((model) => [model.id, model]))
        },
        update: () => {},
        remove: () => {},
      },
    }

    const discovered = [
      {
        id: "qwen-hidden",
        protocol: "responses" as const,
        contextLength: 272000,
        maxContextLength: 872000,
        maxOutputLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsTools: true,
        reasoningDefault: "medium",
        reasoningSupported: ["low", "medium", "high", "xhigh", "max"],
      },
    ]
    const bridge = {
      baseURL: "http://127.0.0.1:43123/v1",
      headers: { "x-opencode-mtls-bridge": "secret" },
    }

    expect(
      usesResponses(
        {
          baseURL: "https://llm.example.test/v1",
          tls: { certFile: "/client.crt", keyFile: "/client.key" },
        },
        discovered,
      ),
    ).toBe(true)

    applyProvider(
      editor,
      "codex-proxy",
      {
        name: "Codex Proxy",
        baseURL: "https://llm.example.test/v1",
        tls: { certFile: "/client.crt", keyFile: "/client.key" },
      },
      discovered,
      bridge,
    )

    const record = records.get("codex-proxy")
    expect(record.provider).toMatchObject({
      id: "codex-proxy",
      name: "Codex Proxy",
      activation: "enabled",
      package: "@opencode/ai/providers/openai/responses",
      headers: { "x-opencode-mtls-bridge": "secret" },
      settings: {
        baseURL: "http://127.0.0.1:43123/v1",
        transport: "websocket",
      },
    })
    expect(record.provider.settings.apiKey).toBeUndefined()
    expect(record.provider.settings.store).toBeUndefined()
    expect(() => structuredClone(record.provider)).not.toThrow()
    expect(record.models.get("qwen-hidden")).toMatchObject({
      id: "qwen-hidden",
      modelID: "qwen-hidden",
      providerID: "codex-proxy",
      name: "qwen-hidden",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
      settings: { reasoningSummary: "auto", reasoningEffort: "medium" },
      limit: { context: 872000, output: 128000 },
    })
  })

  test("keeps HTTPS/SSE available when transport=http is selected", () => {
    const records = new Map<string, any>()
    const editor = editorFor(records)

    applyProvider(
      editor,
      "responses-http",
      {
        baseURL: "https://llm.example.test/v1",
        protocol: "responses",
        transport: "http",
        tls: { certFile: "/client.crt", keyFile: "/client.key" },
      },
      [{ id: "responses-model", protocol: "responses" }],
      {
        baseURL: "http://127.0.0.1:43125/v1",
        headers: { "x-opencode-mtls-bridge": "secret3" },
      },
    )

    expect(records.get("responses-http").provider.settings.transport).toBe("http")
  })

  test("uses the native OpenAI-compatible provider for chat-completions models", () => {
    const records = new Map<string, any>()
    const editor = editorFor(records)

    applyProvider(
      editor,
      "chat-proxy",
      {
        baseURL: "https://chat.example.test/v1",
        protocol: "chat-completions",
        tls: { certFile: "/client.crt", keyFile: "/client.key" },
      },
      [{ id: "plain-model", protocol: "chat-completions" }],
      {
        baseURL: "http://127.0.0.1:43124/v1",
        headers: { "x-opencode-mtls-bridge": "secret2" },
      },
    )

    expect(records.get("chat-proxy").provider).toMatchObject({
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "http://127.0.0.1:43124/v1",
        transport: "http",
        provider: "chat-proxy",
      },
    })
  })
})

function editorFor(records: Map<string, any>): ProviderEditor {
  return {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    add: (definition) => {
      records.set(definition.info.id, {
        provider: definition.info,
        models: new Map(definition.models.map((model) => [model.id, model])),
      })
    },
    update: (id, update) => {
      const record = records.get(id)
      if (!record) throw new Error(`missing provider ${id}`)
      update(record.provider)
    },
    remove: (id) => {
      records.delete(id)
    },
    models: {
      set: (id, models) => {
        const record = records.get(id)
        if (!record) throw new Error(`missing provider ${id}`)
        record.models = new Map(models.map((model) => [model.id, model]))
      },
      update: () => {},
      remove: () => {},
    },
  }
}
