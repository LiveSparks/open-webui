import { describe, expect, it } from "vitest";
import { loadConfig, validateChatId } from "../src/config.ts";

describe("loadConfig", () => {
	it("refuses to start on an incomplete setup and names the missing variables", () => {
		expect(() => loadConfig({})).toThrow("AGENT_SIDECAR_PORT, AGENT_SIDECAR_AGENT_DIR, AGENT_SIDECAR_MODEL, AGENT_SESSIONS");
		expect(() =>
			loadConfig({ AGENT_SIDECAR_PORT: "8080", AGENT_SIDECAR_AGENT_DIR: "/tmp", AGENT_SIDECAR_MODEL: "p/m" }),
		).toThrow("AGENT_SESSIONS");
	});

	it("rejects a malformed model id and port", () => {
		const base = {
			AGENT_SIDECAR_PORT: "8080",
			AGENT_SIDECAR_AGENT_DIR: "/tmp",
			AGENT_SESSIONS: "/tmp/sessions",
		};
		expect(() => loadConfig({ ...base, AGENT_SIDECAR_MODEL: "noseparator" })).toThrow("provider/model");
		expect(() => loadConfig({ ...base, AGENT_SIDECAR_MODEL: "p/m", AGENT_SIDECAR_PORT: "notaport" })).toThrow("AGENT_SIDECAR_PORT");
	});

	it("rejects chat ids that could escape the sessions root", () => {
		expect(() => validateChatId("../../etc")).toThrow("chat id");
		expect(() => validateChatId("chat/../escape")).toThrow("chat id");
		expect(() => validateChatId("a-chat_id.1")).not.toThrow();
	});
});
