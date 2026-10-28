/**
 * OpenCode release E2E test. Unlike the Bun unit tests this boots a real OpenCode CLI,
 * loads this checkout as a plugin, and completes a Responses turn over mutual TLS.
 *
 * Run: OPENCODE_BIN=/path/to/opencode bun run test:e2e
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const executable = process.env.OPENCODE_BIN || "opencode"
const pluginPackage = process.env.OPENCODE_E2E_PLUGIN_PACKAGE || repository
const model = "ci-responses-model"
const provider = "ci-mtls"
const marker = "OPENCODE_MTLS_E2E_SUCCESS"
const prompt = "Reply briefly to this integration test."
const directory = await mkdtemp(path.join(tmpdir(), "opencode-mtls-e2e-"))
const seen: { models: number; requests: Array<{ transport: string; body: Record<string, unknown> }> } = {
  models: 0,
  requests: [],
}
let server: ReturnType<typeof Bun.serve> | undefined

type SocketData = { kind: "responses" }

try {
  await certificates()
  server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    tls: {
      cert: Bun.file(path.join(directory, "server.crt")),
      key: Bun.file(path.join(directory, "server.key")),
      ca: Bun.file(path.join(directory, "ca.crt")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    async fetch(request, service) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models" && request.method === "GET") {
        seen.models++
        return Response.json({
          object: "list",
          data: [{
            id: model,
            object: "model",
            api: "responses",
            supports_reasoning_effort_updates: true,
            context_length: 128_000,
            max_output_length: 2048,
            input_modalities: ["text"],
            output_modalities: ["text"],
            supported_features: ["tools"],
          }],
        })
      }
      if (url.pathname === "/v1/responses" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return service.upgrade(request, { data: { kind: "responses" } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 500 })
      }
      if (url.pathname === "/v1/responses" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>
        seen.requests.push({ transport: "http", body })
        return new Response(
          events().map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(`Unexpected mock request: ${request.method} ${url.pathname}`, { status: 404 })
    },
    websocket: {
      data: {} as SocketData,
      message(socket, message) {
        const body = JSON.parse(String(message)) as Record<string, unknown>
        seen.requests.push({ transport: "websocket", body })
        for (const event of events()) socket.sendText(JSON.stringify(event))
      },
    },
  })

  const base = `https://localhost:${server.port}/v1`
  // Prove that the mock is actually enforcing client certificates, not merely HTTPS.
  let rejected = false
  try {
    await fetch(`${base}/models`, { tls: { ca: Bun.file(path.join(directory, "ca.crt")) }, signal: AbortSignal.timeout(5000) })
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error("Fake mTLS server accepted a connection without a client certificate")

  for (const transport of ["websocket", "http"] as const) {
    const config = path.join(directory, transport, "config")
    const home = path.join(directory, transport, "home")
    const workspace = path.join(directory, transport, "workspace")
    await Promise.all([mkdir(config, { recursive: true }), mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })])
    await writeFile(path.join(config, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugins: [{
        package: pluginPackage,
        options: {
          providers: {
            [provider]: {
              baseURL: base,
              transport,
              tls: {
                certFile: path.join(directory, "client.crt"),
                keyFile: path.join(directory, "client.key"),
                caFile: path.join(directory, "ca.crt"),
              },
            },
          },
        },
      }],
    }, null, 2))

    const priorModels = seen.models
    const priorRequests = seen.requests.length
    const child = Bun.spawn([
      executable, "run", "--standalone", "--model", `${provider}/${model}`,
      "--format", "json", "--print-logs", "--log-level", "info", prompt,
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        PWD: workspace,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: path.join(directory, transport, "cache"),
        XDG_DATA_HOME: path.join(directory, transport, "data"),
        XDG_STATE_HOME: path.join(directory, transport, "state"),
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 90_000)
    let output: string
    let errors: string
    let code: number
    try {
      [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    } finally {
      clearTimeout(deadline)
    }

    const request = seen.requests.slice(priorRequests).find((item) =>
      item.transport === transport &&
      item.body.model === model &&
      JSON.stringify(item.body.input).includes(prompt),
    )
    if (code !== 0 || !output.includes(marker) || seen.models <= priorModels || !request) {
      throw new Error([
        `OpenCode ${transport} E2E failed (exit=${code}, models=${seen.models - priorModels}, inference=${seen.requests.length - priorRequests}, matchingRequest=${Boolean(request)})`,
        `CLI stdout:\n${output.slice(-10_000)}`,
        `Relevant logs:\n${errors.split("\n").filter((line) => /plugin|config|provider|failed|error|loaded|activate|model|tls|runtime|options|service/i.test(line)).join("\n").slice(0, 25000)}`,
        `CLI stderr tail:\n${errors.slice(-5_000)}`,
        `Captured requests:\n${JSON.stringify(seen.requests.slice(priorRequests), null, 2).slice(-5_000)}`,
      ].join("\n"))
    }
    console.log(`PASS: OpenCode ${transport} mTLS model discovery, Responses request and assistant output`)
  }
} finally {
  server?.stop(true)
  if (process.env.OPENCODE_E2E_KEEP_TEMP) console.log(`Kept E2E artifacts: ${directory}`)
  else await rm(directory, { recursive: true, force: true })
}

function events() {
  const item = {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }],
  }
  const response = {
    id: "resp_e2e",
    object: "response",
    status: "completed",
    model,
    output: [item],
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  }
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: marker },
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: marker },
    { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
}

async function openssl(args: string[]) {
  const child = Bun.spawn(["openssl", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" })
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`OpenSSL failed (${code}): ${error}`)
}

async function certificates() {
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=OpenCode mTLS E2E CA", "-days", "1"])
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"])
  await openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-copy_extensions", "copy"])
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=OpenCode mTLS E2E Client", "-addext", "extendedKeyUsage=clientAuth"])
  await openssl(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "1", "-copy_extensions", "copy"])
}
