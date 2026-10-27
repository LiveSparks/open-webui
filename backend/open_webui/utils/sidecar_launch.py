import atexit
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

# Startup contract for the agent sidecar, shared by `backend/start.sh` and
# `open_webui.serve`. Required env: AGENT_SIDECAR_PORT, AGENT_SIDECAR_AGENT_DIR,
# AGENT_SIDECAR_MODEL, AGENT_SESSIONS. With AGENT_SIDECAR_PORT unset the launcher
# exits without doing anything; a broken config retries then degrades to running
# without the agent engine rather than blocking the web UI.

REQUIRED = ('AGENT_SIDECAR_PORT', 'AGENT_SIDECAR_AGENT_DIR', 'AGENT_SIDECAR_MODEL', 'AGENT_SESSIONS')
ENTRY_CANDIDATES = ('sidecar/dist/index.js', '../../sidecar/dist/index.js')
DEFAULT_TIMEOUT_S = 30
DEFAULT_RETRIES = 3
DEFAULT_BACKOFF_S = 2


def _die(message):
    print(f'agent sidecar disabled: {message}', file=sys.stderr, flush=True)


def _resolve_entrypoint(env):
    explicit = env.get('AGENT_SIDECAR_ENTRYPOINT', '').strip()
    if explicit:
        return explicit
    here = Path(__file__).resolve().parents[1]  # open_webui package dir
    for candidate in ENTRY_CANDIDATES:
        path = here / candidate
        if path.is_file():
            return str(path)
    return None


def launch(exit_hook: bool = True):
    # exit_hook=True fits a caller that runs the server in-process (serve):
    # the sidecar dies with it, so nothing is orphaned. exit_hook=False fits a
    # shell bootstrap (start.sh) that execs the server right after: from that
    # point the container or service manager owns the whole process group and
    # the sidecar must survive the launcher subprocess exiting.
    env = os.environ
    missing = [name for name in REQUIRED if not env.get(name, '').strip()]
    if len(missing) == len(REQUIRED):
        return None  # deployment opted out entirely
    if missing:
        _die('incomplete setup, missing: ' + ' '.join(missing))
        return None
    node = env.get('AGENT_SIDECAR_NODE', '').strip() or 'node'
    if shutil.which(node) is None:
        _die('Node runtime not found, set AGENT_SIDECAR_NODE to override')
        return None
    entrypoint = _resolve_entrypoint(env)
    if entrypoint is None or not Path(entrypoint).is_file():
        _die('entrypoint missing')
        return None

    port = env['AGENT_SIDECAR_PORT'].strip()
    timeout_s = int(env.get('AGENT_SIDECAR_STARTUP_TIMEOUT', '') or DEFAULT_TIMEOUT_S)
    retries = int(env.get('AGENT_SIDECAR_START_RETRIES', '') or DEFAULT_RETRIES)
    backoff_s = int(env.get('AGENT_SIDECAR_START_BACKOFF_SECONDS', '') or DEFAULT_BACKOFF_S)

    args = [node, entrypoint]
    attempt = 1
    while True:
        print(f'Starting agent sidecar on port {port} (attempt {attempt}/{retries})...', flush=True)
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        threading.Thread(target=_pump, args=(child,), daemon=True).start()
        if _healthy(child, port, timeout_s):
            print(f'agent sidecar healthy on port {port}', flush=True)
            if exit_hook:
                atexit.register(_stop, child)
            return child
        if child.poll() is None:
            print(f'agent sidecar did not report healthy in {timeout_s}s, stopping it', flush=True)
            _stop(child)
        if attempt >= retries:
            print(f'agent sidecar failed after {attempt} attempts, continuing without the agent engine', flush=True)
            return None
        time.sleep(backoff_s)
        backoff_s *= 2
        attempt += 1


def _healthy(child, port, timeout_s):
    url = f'http://127.0.0.1:{port}/health'
    for _ in range(timeout_s):
        try:
            with urllib.request.urlopen(url, timeout=1):
                return True
        except Exception:
            pass
        if child.poll() is not None:
            print('agent sidecar exited before reporting healthy', flush=True)
            return False
        time.sleep(1)
    return False


def _pump(child):
    for line in child.stdout:
        print(f'[agent-sidecar] {line}', end='', flush=True)


def _stop(child, timeout=5):
    try:
        child.terminate()
        child.wait(timeout=timeout)
    except Exception:
        try:
            child.kill()
        except Exception:
            pass
