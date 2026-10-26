import { readFileSync } from "node:fs";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SidecarConfig {
	host: string;
	port: number;
	agentDir: string;
	modelId: { provider: string; model: string };
	cwd: string;
	sessionsRoot: string;
	version: string;
	piVersion: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value.trim() === "") {
		throw new ConfigError(`missing required environment variable ${name}`);
	}
	return value.trim();
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConfigError(`AGENT_SIDECAR_PORT must be an integer between 1 and 65535, got "${value}"`);
	}
	return port;
}

function parseModelId(value: string): { provider: string; model: string } {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new ConfigError(`AGENT_SIDECAR_MODEL must be "provider/model", got "${value}"`);
	}
	return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

/** Read via import.meta.url so the version resolves from both src/ (specs) and dist/. */
function readPackageVersion(): string {
	const url = new URL("../package.json", import.meta.url);
	const manifest = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
	if (!manifest.version) {
		throw new ConfigError("sidecar/package.json has no version field");
	}
	return manifest.version;
}

/** Version of the installed @earendil-works/pi-coding-agent. import.meta.resolve lands on the entry file, not the package root, so walk up to the manifest. */
function readPiVersion(): string {
	const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	let dir = new URL(".", entryUrl);
	for (let i = 0; i < 8; i++) {
		const manifestUrl = new URL("package.json", dir);
		try {
			const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { name?: string; version?: string };
			if (manifest.name === "@earendil-works/pi-coding-agent" && manifest.version) {
				return manifest.version;
			}
		} catch {
			// not the manifest at this level
		}
		dir = new URL("..", dir);
	}
	throw new ConfigError("could not resolve the installed @earendil-works/pi-coding-agent version");
}

export function validateChatId(chatId: string): string {
	if (!CHAT_ID_PATTERN.test(chatId) || chatId.includes("..")) {
		throw new ConfigError(`chat id must match ${CHAT_ID_PATTERN.source}, got "${chatId}"`);
	}
	return chatId;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
	const missing: string[] = [];
	for (const name of ["AGENT_SIDECAR_PORT", "AGENT_SIDECAR_AGENT_DIR", "AGENT_SIDECAR_MODEL", "AGENT_SESSIONS"]) {
		const value = env[name];
		if (value === undefined || value.trim() === "") {
			missing.push(name);
		}
	}
	if (missing.length > 0) {
		throw new ConfigError(`incomplete sidecar setup, missing ${missing.join(", ")}`);
	}

	return {
		host: env["AGENT_SIDECAR_HOST"]?.trim() || "127.0.0.1",
		port: parsePort(requireEnv(env, "AGENT_SIDECAR_PORT")),
		agentDir: requireEnv(env, "AGENT_SIDECAR_AGENT_DIR"),
		modelId: parseModelId(requireEnv(env, "AGENT_SIDECAR_MODEL")),
		cwd: env["AGENT_SIDECAR_CWD"]?.trim() || process.cwd(),
		sessionsRoot: requireEnv(env, "AGENT_SESSIONS"),
		version: readPackageVersion(),
		piVersion: readPiVersion(),
	};
}
