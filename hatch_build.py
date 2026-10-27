# noqa: INP001
import os
import shutil
import subprocess
from sys import stderr

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Matches the engines floor the sidecar manifest declares; pi is compiled for Node 22.19+.
SIDECAR_NODE_FLOOR = (22, 19, 0)

# Wheel mappings follow the frontend pattern (`build` -> `open_webui/frontend` in pyproject.toml).
SIDECAR_FORCE_INCLUDE = {
    'sidecar/dist': 'open_webui/sidecar/dist',
    'sidecar/node_modules': 'open_webui/sidecar/node_modules',
    'sidecar/package.json': 'open_webui/sidecar/package.json',
}


def node_version_tuple(node):
    try:
        output = subprocess.run(
            [node, '--version'], check=True, capture_output=True, text=True  # noqa: S603
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return tuple(int(part) for part in output.lstrip('v').split('.'))


def build_sidecar(build_data):
    """Compile the agent sidecar into the wheel when the build host can run it.

    A host without Node still gets a working web UI; the agent feature simply
    does not ship in that wheel.
    """
    node = shutil.which('node')
    if node is None:
        stderr.write('### agent sidecar skipped: node not found on PATH\n')
        return
    version = node_version_tuple(node)
    if version is None or version < SIDECAR_NODE_FLOOR:
        stderr.write(f'### agent sidecar skipped: node {version} is older than v22.19.0\n')
        return

    cwd = os.path.dirname(os.path.abspath(__file__))
    stderr.write('\n### build the agent sidecar\n')
    # build.sh owns the recipe (npm ci, tsc, prune) so the wheel and the image
    # build cannot drift apart.
    subprocess.run(['./build.sh'], cwd=os.path.join(cwd, 'sidecar'), check=True)  # noqa: S603

    for source, destination in SIDECAR_FORCE_INCLUDE.items():
        if os.path.exists(os.path.join(cwd, source)):
            build_data['force_include'][source] = destination


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        super().initialize(version, build_data)
        stderr.write('>>> Building Open Webui frontend\n')
        npm = shutil.which('npm')
        if npm is None:
            raise RuntimeError('NodeJS `npm` is required for building Open Webui but it was not found')
        stderr.write('### npm install\n')
        subprocess.run([npm, 'install', '--force'], check=True)  # noqa: S603
        stderr.write('\n### npm run build\n')
        node_options = os.environ.get('NODE_OPTIONS', '')
        if '--max-old-space-size' not in node_options:
            os.environ['NODE_OPTIONS'] = f'{node_options} --max-old-space-size=8192'.strip()
        subprocess.run([npm, 'run', 'build'], check=True)  # noqa: S603
        build_data.setdefault('force_include', {})
        build_sidecar(build_data)
