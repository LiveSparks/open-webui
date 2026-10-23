# Machine binding: pi's local tools rebind to the selected machine, calls loop back through OWUI

The agent's built-in tools (bash, read, edit, write) never run on the sidecar. Each pi session gets same-named replacement tools built on pi's per-tool operations seams, and every operation routes sidecar → OWUI backend loopback executor → `execute_tool_server` on the selected machine. With no machine selected the tools are absent entirely (fail closed), the working directory is a per-chat directory on the machine, and the backend re-resolves the binding per turn; the model never sees or chooses the machine, and the sidecar never learns a machine URL or key.

## Considered options

- **Keep pi's built-ins sidecar-local and add machine tools alongside**: rejected. It would put a shell on the sidecar host, contradicting "execution happens only on the machine the user selected".
- **Sidecar calls the machine directly, headers pre-injected into the binding**: rejected. It would hand machine URLs and credential material to the sidecar; the loopback route keeps OWUI the credential authority and reuses its SSRF sanitization and group access checks.

## Consequences

- The loopback executor endpoint is a new OWUI backend surface, on top of the MCP tool bridge.
- Per-user direct tool-server connections never bind pi's local tools in this effort. They cannot, technically: the loopback route presumes backend-held credentials, and a direct connection's key lives in the user's browser. A second executor route through the browser was rejected (resolved in the per-user direct connections ticket); their ordinary tools still bridge into the loop with execution relayed to the user's browser.
- Nothing agent-facing persists on the sidecar; its data directory holds session state only.
