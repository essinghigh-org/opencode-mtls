import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BRIDGE_HEADER, createMtlsBridge, createMtlsFetch } from "../src/transport"

let directory = ""
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "opencode-mtls-"))
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=OpenCode mTLS Test CA", "-days", "1"])
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ])
  await openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
  ])
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=opencode-mtls-test",
    "-addext",
    "extendedKeyUsage=clientAuth",
  ])
  await openssl([
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "client.crt",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
  ])

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The test upstream must outlive Bun's default 10-second server idle timeout
    // so the bridge itself is the only timeout under test.
    idleTimeout: 0,
    tls: {
      cert: Bun.file(path.join(directory, "server.crt")),
      key: Bun.file(path.join(directory, "server.key")),
      ca: Bun.file(path.join(directory, "ca.crt")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    async fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === "/v1/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(request, {
          data: { bridgeHeader: request.headers.get(BRIDGE_HEADER) },
        })
        return upgraded ? undefined : new Response("upgrade failed", { status: 500 })
      }

      if (url.pathname === "/v1/echo") {
        return new Response(
          JSON.stringify({
            method: request.method,
            pathname: url.pathname,
            search: url.search,
            body: await request.text(),
            bridgeHeader: request.headers.get(BRIDGE_HEADER),
            acceptEncoding: request.headers.get("accept-encoding"),
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-encoding": "identity",
            },
          },
        )
      }

      if (url.pathname === "/v1/stream") {
        const body = await request.json() as Record<string, unknown>
        expect(body.stream).toBe(true)
        return new Response(
          [
            "event: response.created",
            'data: {"type":"response.created"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed"}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      if (url.pathname === "/v1/slow-stream") {
        const body = await request.json() as Record<string, unknown>
        expect(body.stream).toBe(true)
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n'))
              await Bun.sleep(13_000)
              controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      return new Response("mTLS ok")
    },
    websocket: {
      data: {} as { bridgeHeader: string | null },
      maxPayloadLength: 32 * 1024 * 1024,
      message(socket, message) {
        const text = typeof message === "string" ? message : message.toString()
        socket.send(JSON.stringify({
          ...(text.length <= 1024 ? { message: text } : { messageLength: text.length }),
          bridgeHeader: socket.data.bridgeHeader,
        }))
      },
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe("createMtlsFetch", () => {
  test("authenticates with a client certificate", async () => {
    const mtlsFetch = await createMtlsFetch({
      certFile: path.join(directory, "client.crt"),
      keyFile: path.join(directory, "client.key"),
      caFile: path.join(directory, "ca.crt"),
    })

    const response = await mtlsFetch(`https://127.0.0.1:${server.port}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("mTLS ok")
  })

  test("rejects a client without a certificate", async () => {
    await expect(
      fetch(`https://127.0.0.1:${server.port}/`, {
        tls: { ca: Bun.file(path.join(directory, "ca.crt")) },
      }),
    ).rejects.toThrow()
  })
})

describe("createMtlsBridge", () => {
  test("forwards native provider HTTP through mTLS without exposing the bridge capability", async () => {
    const bridge = await createMtlsBridge(`https://127.0.0.1:${server.port}/v1`, tlsFiles())
    try {
      const denied = await fetch(`${bridge.baseURL}/echo`)
      expect(denied.status).toBe(403)

      const response = await fetch(`${bridge.baseURL}/echo?x=1`, {
        method: "POST",
        headers: {
          ...bridge.headers,
          "content-type": "application/json",
        },
        body: '{"hello":"world"}',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(await response.json()).toEqual({
        method: "POST",
        pathname: "/v1/echo",
        search: "?x=1",
        body: '{"hello":"world"}',
        bridgeHeader: null,
        acceptEncoding: "identity",
      })
    } finally {
      bridge.close()
    }
  })

  test("forwards WebSocket frames through mTLS without exposing the bridge capability", async () => {
    const bridge = await createMtlsBridge(`https://127.0.0.1:${server.port}/v1`, tlsFiles())
    const BunWebSocket = WebSocket as unknown as {
      new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket
    }
    const socket = new BunWebSocket(`${bridge.baseURL.replace(/^http:/, "ws:")}/ws`, {
      headers: bridge.headers,
    })

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true })
      })
      socket.send("hello")
      const message = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
        socket.addEventListener("error", () => reject(new Error("websocket message failed")), { once: true })
      })
      expect(JSON.parse(message)).toEqual({ message: "hello", bridgeHeader: null })
    } finally {
      socket.close()
      bridge.close()
    }
  })

  test("forwards WebSocket request frames larger than Bun's default 16 MiB limit", async () => {
    const bridge = await createMtlsBridge(`https://127.0.0.1:${server.port}/v1`, tlsFiles())
    const BunWebSocket = WebSocket as unknown as {
      new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket
    }
    const socket = new BunWebSocket(`${bridge.baseURL.replace(/^http:/, "ws:")}/ws`, {
      headers: bridge.headers,
    })

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true })
      })

      const payload = "x".repeat(17 * 1024 * 1024)
      socket.send(payload)
      const message = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
        socket.addEventListener("error", () => reject(new Error("websocket message failed")), { once: true })
      })
      expect(JSON.parse(message)).toEqual({
        messageLength: payload.length,
        bridgeHeader: null,
      })
    } finally {
      socket.close()
      bridge.close()
    }
  })

  test("keeps streamed Responses streaming and normalizes Codex text/plain SSE", async () => {
    const bridge = await createMtlsBridge(`https://127.0.0.1:${server.port}/v1`, tlsFiles())
    try {
      const response = await fetch(`${bridge.baseURL}/stream`, {
        method: "POST",
        headers: {
          ...bridge.headers,
          "content-type": "application/json",
        },
        body: '{"stream":true}',
      })

      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
      const text = await response.text()
      expect(text).toContain("event: response.created")
      expect(text).toContain("event: response.completed")
    } finally {
      bridge.close()
    }
  })

  test("keeps SSE alive through more than Bun's default 10-second idle timeout", async () => {
    const bridge = await createMtlsBridge(`https://127.0.0.1:${server.port}/v1`, tlsFiles())
    try {
      const response = await fetch(`${bridge.baseURL}/slow-stream`, {
        method: "POST",
        headers: {
          ...bridge.headers,
          "content-type": "application/json",
        },
        body: '{"stream":true}',
      })

      const text = await response.text()
      expect(text).toContain("event: response.created")
      expect(text).toContain("event: response.completed")
    } finally {
      bridge.close()
    }
  }, 15_000)
})

function tlsFiles() {
  return {
    certFile: path.join(directory, "client.crt"),
    keyFile: path.join(directory, "client.key"),
    caFile: path.join(directory, "ca.crt"),
  }
}

async function openssl(args: string[]) {
  const process = Bun.spawn(["openssl", ...args], {
    cwd: directory,
    stdout: "ignore",
    stderr: "pipe",
  })
  const code = await process.exited
  if (code === 0) return
  throw new Error(`openssl failed (${code}): ${await new Response(process.stderr).text()}`)
}
