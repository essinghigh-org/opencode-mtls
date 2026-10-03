import { Plugin } from "@opencode/plugin"
import { applyProvider } from "./catalog"
import { discoverModels } from "./models"
import { parseOptions } from "./options"
import { createMtlsBridge, createMtlsFetch } from "./transport"

export default Plugin.define({
  id: "opencode-mtls",
  setup: async (ctx) => {
    const options = parseOptions(ctx.options)
    const providers = new Map<
      string,
      {
        config: (typeof options.providers)[string]
        models: Awaited<ReturnType<typeof discoverModels>>
        bridge: Awaited<ReturnType<typeof createMtlsBridge>>
      }
    >()

    try {
      for (const [id, config] of Object.entries(options.providers)) {
        const transport = await createMtlsFetch(config.tls)
        const models = await discoverModels(config.baseURL, transport)
        const bridge = await createMtlsBridge(config.baseURL, config.tls)
        providers.set(id, { config, models, bridge })
      }

      await ctx.provider.transform((editor) => {
        for (const [id, provider] of providers) {
          applyProvider(editor, id, provider.config, provider.models, provider.bridge)
        }
      })
    } catch (error) {
      for (const provider of providers.values()) provider.bridge.close()
      throw error
    }

    return () => {
      for (const provider of providers.values()) provider.bridge.close()
    }
  },
})
