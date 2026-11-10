"""pytest setup for the CLI agent (travel_agent.py).

Offline by design: no API keys, no network. Optional heavy dependencies (chromadb, voyageai) and
the SDK/dotenv are stubbed only when they aren't installed, so the suite runs from a minimal
`pip install -r requirements-dev.txt`.
"""
import importlib.util
import os
import sys
import types

for _name in ("chromadb", "voyageai", "anthropic", "dotenv"):
    if importlib.util.find_spec(_name) is None:
        _stub = types.ModuleType(_name)
        _stub.Anthropic = object
        _stub.load_dotenv = lambda *a, **k: None
        _stub.PersistentClient = lambda *a, **k: None
        _stub.Client = lambda *a, **k: None
        sys.modules[_name] = _stub

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Never let a developer's config.env leak keys into tests.
for _var in ("ANTHROPIC_API_KEY", "VOYAGE_API_KEY"):
    os.environ.pop(_var, None)
