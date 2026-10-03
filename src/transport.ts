import type { TLSFiles } from "./options"
import { resolveFile } from "./options"

export const BRIDGE_HEADER = "x-opencode-mtls-bridge"

export type MtlsBridge = {
  baseURL: string
  headers: Record<string, string>
  close(): void
}

export async function createMtlsFetch(input: TLSFiles) {
  const certFile = resolveFile(input.certFile)
  const keyFile = resolveFile(input.keyFile)
  const caFiles = input.caFile === undefined ? [] : Array.isArray(input.caFile) ? input.caFile : [input.caFile]

  await Promise.all([
    requireFile(certFile, "client certificate"),
    requireFile(keyFile, "client private key"),
    ...caFiles.map((file) => requireFile(resolveFile(file), "CA certificate")),
  ])

  const passphrase = input.passphraseEnv ? process.env[input.passphraseEnv] : undefined
  if (input.passphraseEnv && passphrase === undefined) {
    throw new Error(`environment variable ${input.passphraseEnv} is not set`)
  }

  const ca = caFiles.map((file) => Bun.file(resolveFile(file)))
  const tls: BunFetchRequestInitTLS = {
    cert: Bun.file(certFile),
    key: Bun.file(keyFile),
    ...(ca.length > 0 ? { ca } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(input.serverName ? { serverName: input.serverName } : {}),
  }

  return ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(request, { ...(init ?? {}), tls })) as typeof fetch
}

export async function createMtlsBridge(baseURL: string, input: TLSFiles): Promise<MtlsBridge> {
  const remote = new URL(baseURL)
  const mtlsFetch = await createMtlsFetch(input)
  const token = crypto.randomUUID() + crypto.randomUUID()

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (request.headers.get(BRIDGE_HEADER) !== token) {
        return new Response("Forbidden", { status: 403 })
      }

      const incoming = new URL(request.url)
      const target = new URL(incoming.pathname + incoming.search, remote.origin)
      const headers = new Headers(request.headers)
      headers.delete(BRIDGE_HEADER)
      headers.delete("host")
      headers.delete("content-length")
      // Bun fetch transparently decodes compressed upstream responses. Do not
      // request compression here, otherwise forwarding the original
      // Content-Encoding header can make OpenCode decode an already-decoded body.
      headers.set("accept-encoding", "identity")

      const method = request.method
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await request.arrayBuffer()

      const stream = body ? streamedRequest(body, headers.get("content-type")) : false
      // Bun.serve defaults to a 10-second idle timeout. Reasoning-heavy SSE
      // responses can legitimately go quiet for longer than that between events,
      // so disable the loopback server timeout for streaming requests.
      if (stream) server.timeout(request, 0)

      const response = await mtlsFetch(target, {
        method,
        headers,
        body,
        signal: request.signal,
      })
      const responseHeaders = new Headers(response.headers)
      // Bun fetch may transparently decode compressed responses. Never forward
      // compression/length metadata from the upstream representation to the
      // locally re-emitted Response body.
      responseHeaders.delete("content-encoding")
      responseHeaders.delete("content-length")
      responseHeaders.delete("transfer-encoding")

      // ChatGPT Codex currently emits SSE framing with text/plain on HTTP.
      // OpenCode's native provider is entitled to see this as the SSE stream it requested.
      if (stream && response.ok) responseHeaders.set("content-type", "text/event-stream; charset=utf-8")

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    },
  })

  const local = new URL(remote)
  local.protocol = "http:"
  local.hostname = "127.0.0.1"
  local.port = String(server.port)

  return {
    baseURL: local.toString().replace(/\/$/, ""),
    headers: { [BRIDGE_HEADER]: token },
    close: () => server.stop(true),
  }
}

function streamedRequest(body: ArrayBuffer, contentType: string | null) {
  if (!contentType?.toLowerCase().includes("json")) return false
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).stream === true)
  } catch {
    return false
  }
}

async function requireFile(file: string, label: string) {
  if (!(await Bun.file(file).exists())) throw new Error(`${label} does not exist: ${file}`)
}
