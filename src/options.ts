import { homedir } from "node:os"
import path from "node:path"

export type TLSFiles = {
  certFile: string
  keyFile: string
  caFile?: string | string[]
  passphraseEnv?: string
  serverName?: string
}

export type ProviderOptions = {
  name?: string
  baseURL: string
  package?: string
  protocol?: "auto" | "responses" | "chat-completions"
  settings?: Record<string, unknown>
  tls: TLSFiles
}

export type Options = {
  providers: Record<string, ProviderOptions>
}

export function parseOptions(input: unknown): Options {
  const root = record(input, "plugin options")
  const providers = record(root.providers, "options.providers")
  const entries = Object.entries(providers)
  if (entries.length === 0) throw new Error("options.providers must contain at least one provider")

  return {
    providers: Object.fromEntries(entries.map(([id, value]) => [id, parseProvider(id, value)])),
  }
}

export function resolveFile(input: string) {
  if (input === "~") return homedir()
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2))
  return path.resolve(input)
}

function parseProvider(id: string, input: unknown): ProviderOptions {
  if (!id.trim()) throw new Error("provider IDs must not be empty")

  const value = record(input, `provider ${id}`)
  const baseURL = string(value.baseURL, `providers.${id}.baseURL`)
  const url = new URL(baseURL)
  if (url.protocol !== "https:") throw new Error(`providers.${id}.baseURL must use https:// for mTLS`)

  const tls = record(value.tls, `providers.${id}.tls`)
  const ca = tls.caFile
  if (
    ca !== undefined &&
    typeof ca !== "string" &&
    !(Array.isArray(ca) && ca.every((item) => typeof item === "string" && item.length > 0))
  ) {
    throw new Error(`providers.${id}.tls.caFile must be a path or array of paths`)
  }

  const protocol = optionalString(value.protocol, `providers.${id}.protocol`)
  if (protocol !== undefined && protocol !== "auto" && protocol !== "responses" && protocol !== "chat-completions") {
    throw new Error(`providers.${id}.protocol must be auto, responses, or chat-completions`)
  }

  return {
    name: optionalString(value.name, `providers.${id}.name`),
    baseURL,
    package: optionalString(value.package, `providers.${id}.package`),
    protocol: protocol as ProviderOptions["protocol"],
    settings: value.settings === undefined ? undefined : record(value.settings, `providers.${id}.settings`),
    tls: {
      certFile: string(tls.certFile, `providers.${id}.tls.certFile`),
      keyFile: string(tls.keyFile, `providers.${id}.tls.keyFile`),
      caFile: ca,
      passphraseEnv: optionalString(tls.passphraseEnv, `providers.${id}.tls.passphraseEnv`),
      serverName: optionalString(tls.serverName, `providers.${id}.tls.serverName`),
    },
  }
}

function record(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${name} must be an object`)
  return input as Record<string, unknown>
}

function string(input: unknown, name: string) {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${name} must be a non-empty string`)
  return input
}

function optionalString(input: unknown, name: string) {
  if (input === undefined) return
  return string(input, name)
}
