import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { createHttpSurface } from "./http.ts";
import { resolveModel, SessionRegistry } from "./session.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const modelRuntime = await ModelRuntime.create({
		authPath: `${config.agentDir}/auth.json`,
		modelsPath: `${config.agentDir}/models.json`,
	});
	const model = resolveModel(config, modelRuntime);
	const registry = new SessionRegistry(config, modelRuntime, model);
	const surface = createHttpSurface({ config, registry });

	await surface.listen();
	console.log(
		`agent sidecar v${config.version} listening on http://${config.host}:${config.port} ` +
			`(pi ${config.piVersion}, model ${config.modelId.provider}/${config.modelId.model}, ` +
			`sessions ${config.sessionsRoot})`,
	);

	const shutdown = (signal: string) => {
		console.log(`agent sidecar received ${signal}, shutting down`);
		void registry
			.disposeAll()
			.then(() => surface.close())
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
	console.error(`agent sidecar refused to start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
