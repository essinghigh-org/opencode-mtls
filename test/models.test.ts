import { describe, expect, test } from "bun:test"
import { discoverModels } from "../src/models"

describe("discoverModels", () => {
  test("loads standard and enhanced OpenAI-compatible /models data", async () => {
    let requested = ""
    const transport = (async (input: Parameters<typeof fetch>[0]) => {
      requested = String(input)
      return Response.json({
        object: "list",
        data: [
          { id: "plain-model", object: "model", created: 1_700_000_000, owned_by: "proxy" },
          {
            id: "qwen-hidden",
            name: "qwen-hidden",
            api: "responses",
            context_length: 272000,
            max_context_length: 872000,
            max_output_length: 128000,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            supported_features: ["tools", "reasoning", "vision"],
            reasoning: {
              default: "medium",
              supported: ["low", "medium", "high", "xhigh"],
            },
          },
        ],
      })
    }) as unknown as typeof fetch

    expect(await discoverModels("https://llm.example.test/v1", transport)).toEqual([
      { id: "plain-model", created: 1_700_000_000 },
      {
        id: "qwen-hidden",
        name: "qwen-hidden",
        contextLength: 272000,
        maxContextLength: 872000,
        maxOutputLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsTools: true,
        protocol: "responses",
        reasoningDefault: "medium",
        reasoningSupported: ["low", "medium", "high", "xhigh"],
      },
    ])
    expect(requested).toBe("https://llm.example.test/v1/models")
  })

  test("rejects malformed model responses", async () => {
    const transport = (async () => Response.json({ models: [] })) as unknown as typeof fetch
    await expect(discoverModels("https://llm.example.test/v1", transport)).rejects.toThrow("invalid model response")
  })
})
