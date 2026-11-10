"""Prints the CLI agent's tool contracts as JSON, for the web/CLI parity test.

Heavy or optional dependencies (chromadb, voyageai, anthropic, python-dotenv) are stubbed when not
installed: only module-level constants of travel_agent.py are read, nothing is called.
"""
import importlib.util
import json
import os
import sys
import types

for name in ("chromadb", "voyageai", "anthropic", "dotenv"):
    if importlib.util.find_spec(name) is None:
        stub = types.ModuleType(name)
        stub.Anthropic = object
        stub.load_dotenv = lambda *a, **k: None
        sys.modules[name] = stub

repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, repo_root)

import travel_agent  # noqa: E402

print(json.dumps({"tools": travel_agent.TOOLS, "wmo": travel_agent._WMO_CONDITIONS, "dispatch": sorted(travel_agent.TOOL_FUNCTIONS)}))
