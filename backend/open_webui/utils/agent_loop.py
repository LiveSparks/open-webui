"""The agent-loop routing table (PR3): the model ids the pi loop owns.

`AGENT_LOOP_MODEL_IDS` lists the model ids routed through the sidecar's agent
loop. The chat router reads it per send, and /api/models surfaces an additive
`agent_loop` flag for those ids so the composer's send-during-generation UI
(P10) can scope steering to agent-routed models. Read fresh at every call: a
changed environment takes effect on the next request, no code reload.
"""

import os


def agent_loop_model_ids() -> set[str]:
    return {model_id.strip() for model_id in os.environ.get('AGENT_LOOP_MODEL_IDS', '').split(',') if model_id.strip()}
