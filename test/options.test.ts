import { describe, expect, test } from "bun:test"
import { parseOptions } from "../src/options"

describe("parseOptions", () => {
  test("accepts an mTLS provider", () => {
    expect(
      parseOptions({
        providers: {
          proxy: {
            name: "Proxy",
            baseURL: "https://llm.example.test/v1",
            transport: "websocket",
            tls: {
              certFile: "/tmp/client.crt",
              keyFile: "/tmp/client.key",
              caFile: ["/tmp/root.crt", "/tmp/intermediate.crt"],
            },
          },
        },
      }),
    ).toEqual({
      providers: {
        proxy: {
          name: "Proxy",
          baseURL: "https://llm.example.test/v1",
          package: undefined,
          transport: "websocket",
          settings: undefined,
          tls: {
            certFile: "/tmp/client.crt",
            keyFile: "/tmp/client.key",
            caFile: ["/tmp/root.crt", "/tmp/intermediate.crt"],
            passphraseEnv: undefined,
            serverName: undefined,
          },
        },
      },
    })
  })

  test("rejects non-TLS endpoints", () => {
    expect(() =>
      parseOptions({
        providers: {
          proxy: {
            baseURL: "http://llm.example.test/v1",
            tls: { certFile: "client.crt", keyFile: "client.key" },
          },
        },
      }),
    ).toThrow("must use https://")
  })

  test("rejects unknown transports", () => {
    expect(() =>
      parseOptions({
        providers: {
          proxy: {
            baseURL: "https://llm.example.test/v1",
            transport: "quic",
            tls: { certFile: "client.crt", keyFile: "client.key" },
          },
        },
      }),
    ).toThrow("transport must be auto, http, or websocket")
  })

  test("requires at least one provider", () => {
    expect(() => parseOptions({ providers: {} })).toThrow("must contain at least one provider")
  })
})
