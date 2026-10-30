import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createServer, type Server } from "node:http";
import {
	buildProviderCatalog,
	ensureTurnModel,
	parseTurnEnvelope,
	synthesizedProviderId,
} from "../src/providers.ts";
import { buildTestBed, type TestBed } from "./helpers.ts";

let bed: TestBed;

beforeEach(async () => {
	bed = await buildTestBed("providers");
});

afterEach(async () => {
	await bed.cleanup();
});

/** A loopback stand-in for the backend key route: records its calls, answers one key. */
function startKeyRoute(key: string): Promise<{ port: number; calls: { auth: string; url: string }[]; close: () => Promise<void> }> {
	const calls: { auth: string; url: string }[] = [];
	const server: Server = createServer((req, res) => {
		calls.push({ auth: String(req.headers.authorization ?? ""), url: req.url ?? "" });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, apiKey: key }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no key route port");
			resolve({
				port: address.port,
				calls,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function bindingFor(port: number): { url: string; token: string } {
	return { url: `http://127.0.0.1:${port}/loopback/mcp`, token: "binding-token" };
}

describe("parseTurnEnvelope", () => {
	it("parses a full envelope and rejects a malformed one", () => {
		const envelope = parseTurnEnvelope({
			model: { provider: "specfake", id: "scripted" },
			thinkingLevel: "high",
			headers: { "X-Chat": "c1", "X-Drop": null },
			params: { temperature: 0.5 },
			keyUrl: "http://127.0.0.1:9/loopback/agent/key",
		});
		expect(envelope).toMatchObject({
			model: { provider: "specfake", id: "scripted" },
			thinkingLevel: "high",
			params: { temperature: 0.5 },
		});
		expect(envelope?.headers).toEqual({ "X-Chat": "c1", "X-Drop": null });

		expect(() => parseTurnEnvelope({ model: { provider: "specfake" } })).toThrow("turn.model");
		expect(() => parseTurnEnvelope({ model: { provider: "specfake", id: "m" }, provider: { id: "x" } })).toThrow(
			"baseUrl",
		);
		expect(() => parseTurnEnvelope({ model: { provider: "specfake", id: "m" }, keyUrl: "not-a-url" })).toThrow(
			"keyUrl",
		);
		expect(parseTurnEnvelope(undefined)).toBeUndefined();
	});
});

describe("ensureTurnModel", () => {
	it("resolves a built-in pair off the runtime catalog", () => {
		const model = ensureTurnModel(bed.registry["modelRuntime"] as ModelRuntime, {
			model: { provider: "specfake", id: "scripted" },
		});
		expect(model.id).toBe("scripted");
	});

	it("registers a synthesized provider entry and resolves through it", () => {
		const runtime = bed.registry["modelRuntime"] as ModelRuntime;
		const synthId = synthesizedProviderId("http://127.0.0.1:1/v1");
		const model = ensureTurnModel(runtime, {
			model: { provider: synthId, id: "relay-model" },
			provider: {
				id: synthId,
				name: "OWUI Connection",
				baseUrl: "http://127.0.0.1:1/v1",
				api: "openai-completions",
				models: [{ id: "relay-model", name: "Relay", reasoning: false }],
			},
		});
		expect(model.id).toBe("relay-model");
		// Idempotent: a second application over the same entry still resolves.
		expect(ensureTurnModel(runtime, { model: { provider: synthId, id: "relay-model" } }).id).toBe("relay-model");
	});
});

describe("the per-turn handoff on a live prompt", () => {
	it("applies the header map, body params, thinking level, and the per-call key", async () => {
		const keyRoute = await startKeyRoute("sk-live-1");
		try {
			await bed.registry.get("chat-handoff", undefined, bindingFor(keyRoute.port));
			const events: { event: string }[] = [];
			const result = await bed.registry.prompt(
				"chat-handoff",
				"hello",
				(event) => events.push({ event: String((event as { type?: string }).type) }),
				{
					turn: {
						model: { provider: "specfake", id: "scripted-thinker" },
						thinkingLevel: "high",
						headers: { "X-OWUI-Chat-Id": "chat-handoff", "X-OpenRouter-Title": null },
						params: { temperature: 0.5, response_format: { type: "json_object" } },
						keyUrl: `http://127.0.0.1:${keyRoute.port}/loopback/agent/key`,
					},
				},
			);
			expect(result.reason).toBe("completed");

			// The key crossed at the moment of use, never the models.json dummy.
			// (The binding URL also points here, so filter out the bridge's own
			// MCP connect that dials it.)
			const keyCalls = keyRoute.calls.filter((call) => call.url === "/loopback/agent/key");
			expect(keyCalls.length).toBe(1);
			expect(keyCalls[0]?.auth).toBe("Bearer binding-token");
			const entry = { path: "", headers: {} as Record<string, string>, body: "" };
			const recorded = bed.fake.entries.at(-1) ?? entry;
			expect(recorded.headers["authorization"]).toBe("Bearer sk-live-1");
			// OWUI's header map rode the per-request seam; the null deleted pi's own header.
			expect(recorded.headers["x-owui-chat-id"]).toBe("chat-handoff");
			expect(recorded.headers["x-openrouter-title"]).toBeUndefined();
			// The resolved params merged into the outgoing payload.
			const body = JSON.parse(recorded.body) as Record<string, unknown>;
			expect(body["temperature"]).toBe(0.5);
			expect(body["response_format"]).toEqual({ type: "json_object" });
			// The chosen effort rode the request in the model's own dialect.
			expect(body["reasoning_effort"]).toBe("high");
		} finally {
			await keyRoute.close();
		}
	});

	it("switches models between turns: the next turn uses the new model, no fork", async () => {
		const keyRoute = await startKeyRoute("sk-live-2");
		try {
			await bed.registry.get("chat-switch", undefined, bindingFor(keyRoute.port));
			const prompt = (model: { provider: string; id: string }, text: string) =>
				bed.registry.prompt("chat-switch", text, () => {}, {
					turn: {
						model,
						keyUrl: `http://127.0.0.1:${keyRoute.port}/loopback/agent/key`,
					},
				});

			await prompt({ provider: "specfake", id: "scripted" }, "first turn");
			await prompt({ provider: "specfake", id: "scripted-thinker" }, "second turn");

			const bodies = bed.fake.requests.map((raw) => JSON.parse(raw) as { model?: string });
			expect(bodies.at(-2)?.model).toBe("scripted");
			expect(bodies.at(-1)?.model).toBe("scripted-thinker");
			// The turn count proves the switch did not fork the history.
			const last = JSON.parse(bed.fake.requests.at(-1) ?? "{}") as { messages?: { role: string }[] };
			expect(last.messages?.filter((m) => m.role === "user").length).toBe(2);
		} finally {
			await keyRoute.close();
		}
	});

	it("fetches the rotated key on the next provider call", async () => {
		const keyRoute = await startKeyRoute("sk-rotated");
		try {
			await bed.registry.get("chat-rotate", undefined, bindingFor(keyRoute.port));
			const turn = {
				model: { provider: "specfake", id: "scripted" },
				keyUrl: `http://127.0.0.1:${keyRoute.port}/loopback/agent/key`,
			};
			await bed.registry.prompt("chat-rotate", "turn one", () => {}, { turn });
			// The backend answer changes; the sidecar never caches it.
			keyRoute.calls.length = 0;
			await bed.registry.prompt("chat-rotate", "turn two", () => {}, {
				turn: { ...turn, model: { provider: "specfake", id: "scripted" } },
			});
			const keyCalls = keyRoute.calls.filter((call) => call.url === "/loopback/agent/key");
			expect(keyCalls.length).toBe(1);
			expect(bed.fake.entries.at(-1)?.headers["authorization"]).toBe("Bearer sk-rotated");
		} finally {
			await keyRoute.close();
		}
	});
});

describe("buildProviderCatalog", () => {
	it("serves the thinking ladder out of pi's catalogs", () => {
		const catalog = buildProviderCatalog(bed.registry["modelRuntime"] as ModelRuntime);
		const fake = catalog.providers.find((provider) => provider.id === "specfake");
		expect(fake?.baseUrl).toContain("127.0.0.1");
		const thinker = fake?.models.find((model) => model.id === "scripted-thinker");
		expect(thinker?.reasoning).toBe(true);
		// The explicit map hides xhigh/max; the rest follow pi's ladder.
		expect(thinker?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		const plain = fake?.models.find((model) => model.id === "scripted");
		expect(plain?.thinkingLevels).toEqual(["off"]);
	});
});
