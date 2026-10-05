import type { TLSFiles } from "./options"
import { resolveFile } from "./options"

export const BRIDGE_HEADER = "x-opencode-mtls-bridge"

export type MtlsBridge = {
  baseURL: string
  headers: Record<string, string>
  close(): void
}

type BridgeSocketData = {
  target: string
  headers: Record<string, string>
  upstream?: WebSocket
  pending: Array<string | ArrayBuffer>
  closed: boolean
}

async function createMtlsTLS(input: TLSFiles) {
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
  return {
    cert: Bun.file(certFile),
    key: Bun.file(keyFile),
    ...(ca.length > 0 ? { ca } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(input.serverName ? { serverName: input.serverName } : {}),
  }
}

export async function createMtlsFetch(input: TLSFiles) {
  const tls = await createMtlsTLS(input)

  return ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(request, { ...(init ?? {}), tls })) as typeof fetch
}

export async function createMtlsBridge(baseURL: string, input: TLSFiles): Promise<MtlsBridge> {
  const remote = new URL(baseURL)
  const tls = await createMtlsTLS(input)
  const mtlsFetch = ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(request, { ...(init ?? {}), tls })) as typeof fetch
  const token = crypto.randomUUID() + crypto.randomUUID()

  const server = Bun.serve<BridgeSocketData>({
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

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upstream = new URL(target)
        upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:"
        const upgraded = server.upgrade(request, {
          data: {
            target: upstream.toString(),
            headers: websocketForwardHeaders(headers),
            pending: [],
            closed: false,
          },
        })
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 })
      }

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
    websocket: {
      data: {} as BridgeSocketData,
      open(socket) {
        const BunWebSocket = WebSocket as unknown as {
          new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket
        }
        const upstream = new BunWebSocket(socket.data.target, {
          headers: socket.data.headers,
          tls,
        })
        upstream.binaryType = "arraybuffer"
        socket.data.upstream = upstream

        upstream.addEventListener("open", () => {
          if (socket.data.closed) {
            upstream.close()
            return
          }
          for (const message of socket.data.pending.splice(0)) upstream.send(message)
        })
        upstream.addEventListener("message", (event) => {
          if (socket.data.closed) return
          if (typeof event.data === "string") socket.sendText(event.data)
          else if (event.data instanceof ArrayBuffer) socket.sendBinary(event.data)
          else if (event.data instanceof Blob) socket.send(event.data)
        })
        upstream.addEventListener("close", (event) => {
          if (socket.data.closed) return
          socket.data.closed = true
          socket.close(validCloseCode(event.code) ? event.code : 1011, event.reason || "upstream websocket closed")
        })
        upstream.addEventListener("error", () => {
          if (socket.data.closed) return
          socket.data.closed = true
          socket.close(1011, "upstream websocket error")
        })
      },
      message(socket, message) {
        if (socket.data.closed) return
        const payload =
          typeof message === "string"
            ? message
            : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength)
        const upstream = socket.data.upstream
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(payload)
          return
        }
        socket.data.pending.push(payload)
      },
      close(socket) {
        socket.data.closed = true
        socket.data.pending.length = 0
        const upstream = socket.data.upstream
        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
          upstream.close()
        }
      },
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

function websocketForwardHeaders(input: Headers) {
  const headers = new Headers(input)
  for (const name of [
    "connection",
    "upgrade",
    "sec-websocket-accept",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
  ]) {
    headers.delete(name)
  }
  return Object.fromEntries(headers)
}

function validCloseCode(code: number) {
  return code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999)
}
