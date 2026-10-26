import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, type SidecarConfig } from "../src/config.ts";
import { resolveModel, SessionRegistry } from "../src/session.ts";

export function flattenContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
	}
	return "";
}

/**
 * Scripted OpenAI-shaped provider fake. Behaviors are keyed on the prompt text
 * so a test asserts the roundtrip, not a canned constant:
 * - "SLOW" streams many small chunks with delays (for abort mid-generation)
 * - "TOOL_ECHO" makes the fake call the echo tool when one is declared
 * - "COUNT_HISTORY" replies with the number of user messages it received
 * - tool result present replies "tool said: <content>"
 * - anything else replies "echoed: <text>" in two chunks
 */
export function startFakeProvider(): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
	const requests: string[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString()));
		req.on("end", () => {
			requests.push(body);
			const parsed = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const messages = parsed.messages ?? [];
			const declared = (parsed.tools ?? []).map((t) => t.function?.name ?? "");
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const text = flattenContent(lastUser?.content);

			const send = (delta: Record<string, unknown>, finish?: string) => {
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta, finish_reason: finish ?? null }],
					})}\n\n`,
				);
			};
			const finish = () => {
				res.write("data: [DONE]\n\n");
				res.end();
			};

			res.writeHead(200, { "content-type": "text/event-stream" });

			if (text.includes("COUNT_HISTORY")) {
				send({ role: "assistant" });
				send({ content: `history:${messages.filter((m) => m.role === "user").length} user messages` }, "stop");
				finish();
				return;
			}
			const toolResult = messages.find((m) => m.role === "tool");
			if (toolResult) {
				send({ role: "assistant" });
				send({ content: `tool said: ${flattenContent(toolResult.content)}` }, "stop");
				finish();
				return;
			}
			if (declared.includes("echo") && text.includes("TOOL_ECHO")) {
				send({ role: "assistant" });
				send(
					{
						tool_calls: [
							{
								index: 0,
								id: "call_fake_1",
								type: "function",
								function: { name: "echo", arguments: JSON.stringify({ message: `fake-was-here:${text}` }) },
							},
						],
					},
					"tool_calls",
				);
				finish();
				return;
			}
			if (text.startsWith("SLOW")) {
				send({ role: "assistant" });
				let i = 0;
				const timer = setInterval(() => {
					if (res.destroyed) {
						clearInterval(timer);
						return;
					}
					i++;
					send({ content: `chunk${i}` });
					if (i >= 60) {
						clearInterval(timer);
						send({ content: "" }, "stop");
						finish();
					}
				}, 25);
				return;
			}
			send({ role: "assistant" });
			send({ content: `echoed: ${text.slice(0, 3)}` });
			send({ content: text.slice(3) }, "stop");
			finish();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no fake provider port");
			resolve({
				port: address.port,
				requests,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

export interface TestBed {
	fake: Awaited<ReturnType<typeof startFakeProvider>>;
	config: SidecarConfig;
	registry: SessionRegistry;
	cleanup: () => Promise<void>;
}

export async function buildTestBed(name: string): Promise<TestBed> {
	const fake = await startFakeProvider();
	const base = join(tmpdir(), `sidecar-spec-${process.pid}-${name.replace(/[^a-z0-9-]/gi, "")}`);
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				specfake: {
					baseUrl: `http://127.0.0.1:${fake.port}/v1`,
					api: "openai-completions",
					apiKey: "spec-dummy",
					models: [
						{
							id: "scripted",
							name: "Scripted Fake",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32000,
							maxTokens: 8192,
							reasoning: false,
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "auth.json"), "{}\n");

	const env: NodeJS.ProcessEnv = {
		AGENT_SIDECAR_PORT: "1",
		AGENT_SIDECAR_AGENT_DIR: agentDir,
		AGENT_SIDECAR_MODEL: "specfake/scripted",
		AGENT_SIDECAR_CWD: base,
		AGENT_SESSIONS: join(base, "agent_sessions"),
	};
	const config: SidecarConfig = { ...loadConfig(env), port: 0, host: "127.0.0.1" };
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const registry = new SessionRegistry(config, modelRuntime, resolveModel(config, modelRuntime));
	return {
		fake,
		config,
		registry,
		cleanup: async () => {
			await registry.disposeAll();
			await fake.close();
		},
	};
}

export interface SseFrame {
	event: string;
	data: Record<string, unknown>;
}

export async function* parseSse(response: Response): AsyncGenerator<SseFrame> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no response body to read");
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const raw = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
			const eventLine = raw.split("\n").find((l) => l.startsWith("event: "));
			const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
			if (!eventLine || !dataLine) continue;
			const frame: SseFrame = { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> };
			yield frame;
			if (frame.event === "done") return;
		}
	}
}
