"""Execute pristine ComfyUI graph/cache modules. No upstream implementation is copied here.

The test harness supplies only legacy node definitions and non-inference boundaries.
It does not import PromptExecutor, start a server, or claim automatic retry/persistence.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib
import importlib.metadata
import io
import json
import logging
from pathlib import Path
import subprocess
import sys
import time
import traceback
import types
import unittest

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / "sources" / "ComfyUI"
COMMIT = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
assert COMMIT == "e0a32bce84f4603f2b61b16b50f8958e68fd6171", "Unexpected source commit"
sys.path.insert(0, str(SOURCE))


def namespace(name, directory):
    module = types.ModuleType(name)
    module.__path__ = [str(directory)]
    sys.modules[name] = module
    return module


def forbidden_boundary(*args, **kwargs):
    raise AssertionError("Out-of-scope inference or V3-node boundary was unexpectedly called")


# Keep real package submodules importable while skipping eager whole-server/model setup.
namespace("comfy", SOURCE / "comfy")
namespace("comfy.comfy_types", SOURCE / "comfy" / "comfy_types")
namespace("comfy_api", SOURCE / "comfy_api")
namespace("comfy_api.latest", SOURCE / "comfy_api" / "latest")
# Original internal marker class and node_typing are loaded normally from source.
import comfy_api.internal  # noqa: E402
import comfy.comfy_types.node_typing  # noqa: E402

io_boundary = types.ModuleType("comfy_api.latest._io")
io_boundary.get_finalized_class_inputs = forbidden_boundary
sys.modules[io_boundary.__name__] = io_boundary
model_boundary = types.ModuleType("comfy.model_patcher")
model_boundary.is_model_patcher_output = forbidden_boundary
sys.modules[model_boundary.__name__] = model_boundary
memory_boundary = types.ModuleType("comfy.system_memory")
memory_boundary.virtual_memory_available = forbidden_boundary
sys.modules[memory_boundary.__name__] = memory_boundary


class FixtureNode:
    """No model implementation: only a legacy node interface for real graph discovery."""
    FUNCTION = "execute"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {"value": ("INT",), "source": ("INT",), "left": ("INT",), "right": ("INT",), "color": ("STRING",), "lazy": ("INT", {"lazy": True})}}

    def execute(self, **inputs):
        return (inputs,)


class OutputFixture(FixtureNode):
    OUTPUT_NODE = True


nodes_boundary = types.ModuleType("nodes")
nodes_boundary.NODE_CLASS_MAPPINGS = {"Fixture": FixtureNode, "OutputFixture": OutputFixture}
sys.modules["nodes"] = nodes_boundary

# These are the actual modules being tested, directly imported from the Git checkout.
from comfy_execution.graph import DynamicPrompt, ExecutionList, DependencyCycleError, NodeInputError  # noqa: E402
from comfy_execution.graph_utils import GraphBuilder, add_graph_prefix  # noqa: E402
from comfy_execution.caching import BasicCache, CacheKeySetInputSignature  # noqa: E402
from comfy_execution.cache_provider import (  # noqa: E402
    CacheProvider, _serialize_cache_key, _contains_self_unequal,
    register_cache_provider, unregister_cache_provider, _get_cache_providers, _clear_cache_providers,
)


class Unchanged:
    async def get(self, node_id):
        return False


def graph():
    builder = GraphBuilder(prefix="series.")
    source = builder.node("Fixture", id="source", value=1)
    left = builder.node("Fixture", id="left", source=source.out(0), color="sage")
    right = builder.node("Fixture", id="right", source=source.out(0), color="clay")
    builder.node("OutputFixture", id="board", left=left.out(0), right=right.out(0))
    return builder.finalize()


async def cache_for(prompt, existing=None, providers=False):
    cache = existing if existing is not None else BasicCache(CacheKeySetInputSignature, enable_providers=providers)
    dynamic = DynamicPrompt(prompt)
    await cache.set_prompt(dynamic, list(prompt), Unchanged())
    return dynamic, cache


def cache_entry(value):
    # Protocol data only: BasicCache stores arbitrary values; no execution.CacheEntry implementation is tested.
    return types.SimpleNamespace(outputs=[value], ui={})


def hash_probe():
    key = frozenset([("color", "sage"), ("structure", frozenset([("width", 1024), ("height", 1024)]))])
    return _serialize_cache_key(key)


OBSERVATIONS = []


class RealComfyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        _clear_cache_providers()

    async def test_C01_graph_builder_real_prefixes_and_links(self):
        original = graph()
        copied, outputs = add_graph_prefix(original, (["series.board", 0],), "project-B:")
        self.assertEqual(outputs, (["project-B:series.board", 0],))
        self.assertEqual(copied["project-B:series.left"]["inputs"]["source"], ["project-B:series.source", 0])
        self.assertEqual(original["series.left"]["inputs"]["source"], ["series.source", 0])
        self.assertTrue(set(original).isdisjoint(copied))

    async def test_C02_dynamic_override_preserves_submitted_node(self):
        original = graph()
        before = copy.deepcopy(original)
        dynamic = DynamicPrompt(original)
        dynamic.override_node("series.right", {"class_type": "Fixture", "inputs": {"value": 9}})
        dynamic.add_ephemeral_node("child", {"class_type": "Fixture", "inputs": {"value": 8}}, "series.right", "series.board")
        self.assertEqual(original, before)
        self.assertEqual(dynamic.get_node("series.right")["inputs"]["value"], 9)
        self.assertEqual(dynamic.get_real_node_id("child"), "series.right")
        self.assertEqual(dynamic.get_display_node_id("child"), "series.board")

    async def test_C03_original_scheduler_orders_real_dependencies(self):
        prompt = graph()
        dynamic, cache = await cache_for(prompt)
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("series.board")
        order = []
        while not schedule.is_empty():
            node_id, details, error = await schedule.stage_node_execution()
            self.assertIsNone(error, details)
            for value in prompt[node_id]["inputs"].values():
                if isinstance(value, list):
                    self.assertIn(value[0], order)
            order.append(node_id)
            cache.set_local(node_id, cache_entry(node_id))
            schedule.cache_update(node_id, cache.get_local(node_id))
            schedule.complete_node_execution()
        self.assertEqual(order[0], "series.source")
        self.assertEqual(order[-1], "series.board")
        self.assertEqual(len(order), 4)
        OBSERVATIONS.append({"id": "dependency-order", "order": order, "method": "Original ExecutionList stage/cache_update/complete called; output values are fixture data, no inference."})

    async def test_C04_failed_branch_restage_keeps_cached_successes(self):
        dynamic, cache = await cache_for(graph())
        cache.set_local("series.source", cache_entry("retained source"))
        cache.set_local("series.left", cache_entry("retained successful branch"))
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("series.board")
        self.assertEqual(set(schedule.pendingNodes), {"series.right", "series.board"})
        attempts = []
        first, _, error = await schedule.stage_node_execution()
        self.assertIsNone(error)
        self.assertEqual(first, "series.right")
        attempts.append(first)
        # The harness injects one failed external compute operation, then explicitly asks the ORIGINAL scheduler to unstage/retry.
        schedule.unstage_node_execution()
        self.assertEqual(set(schedule.pendingNodes), {"series.right", "series.board"})
        second, _, error = await schedule.stage_node_execution()
        self.assertEqual(second, first)
        attempts.append(second)
        cache.set_local(second, cache_entry("retried output"))
        schedule.cache_update(second, cache.get_local(second))
        schedule.complete_node_execution()
        board, _, error = await schedule.stage_node_execution()
        self.assertEqual(board, "series.board")
        schedule.complete_node_execution()
        self.assertEqual(cache.get_local("series.left").outputs, ["retained successful branch"])
        self.assertTrue(schedule.is_empty())
        OBSERVATIONS.append({"id": "manual-restage", "attempts": attempts, "cachedSuccessReexecuted": False, "boundary": "Manual unstage/restage tested; automatic retry policy, HTTP request deduplication and billing are NOT tested."})

    async def test_C05_cycle_returns_structured_original_error(self):
        prompt = {"a": {"class_type": "Fixture", "inputs": {"source": ["b", 0]}}, "b": {"class_type": "Fixture", "inputs": {"source": ["a", 0]}}}
        dynamic, cache = await cache_for(prompt)
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("a")
        node, details, error = await schedule.stage_node_execution()
        self.assertIsNone(node)
        self.assertIsInstance(error, DependencyCycleError)
        self.assertEqual(details["exception_type"], "graph.DependencyCycleError")
        OBSERVATIONS.append({"id": "cycle-error", "details": details})

    async def test_C06_constant_input_cannot_be_forced_into_dependency_link(self):
        dynamic, cache = await cache_for(graph())
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("series.board")
        with self.assertRaisesRegex(NodeInputError, "constant"):
            schedule.make_input_strong_link("series.left", "color")
        with self.assertRaisesRegex(NodeInputError, "no input"):
            schedule.make_input_strong_link("series.left", "absent")

    async def test_C07_lazy_dependency_only_enters_when_requested(self):
        prompt = {"lazy-source": {"class_type": "Fixture", "inputs": {"value": 1}}, "output": {"class_type": "OutputFixture", "inputs": {"lazy": ["lazy-source", 0]}}}
        dynamic, cache = await cache_for(prompt)
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("output")
        self.assertEqual(set(schedule.pendingNodes), {"output"})
        schedule.make_input_strong_link("output", "lazy")
        self.assertEqual(set(schedule.pendingNodes), {"output", "lazy-source"})
        node, _, _ = await schedule.stage_node_execution()
        self.assertEqual(node, "lazy-source")

    async def test_C08_signature_invalidation_is_branch_local_and_descendant_aware(self):
        prompt = graph()
        _, cache = await cache_for(prompt)
        for key in prompt:
            cache.set_local(key, cache_entry(key))
        modified = copy.deepcopy(prompt)
        modified["series.right"]["inputs"]["color"] = "rose"
        await cache_for(modified, existing=cache)
        self.assertIsNotNone(cache.get_local("series.source"))
        self.assertIsNotNone(cache.get_local("series.left"))
        self.assertIsNone(cache.get_local("series.right"))
        self.assertIsNone(cache.get_local("series.board"))
        cache.clean_unused()
        self.assertEqual(len(cache.cache), 2)
        OBSERVATIONS.append({"id": "selective-invalidation", "retained": ["source", "left"], "invalidated": ["right", "board"]})

    async def test_C09_cache_hash_survives_fresh_process_but_memory_cache_does_not(self):
        first = hash_probe()
        second = subprocess.check_output([sys.executable, "-I", str(Path(__file__).resolve()), "--hash-probe"], text=True).strip()
        self.assertEqual(first, second)
        prompt = graph()
        _, warm = await cache_for(prompt)
        warm.set_local("series.source", cache_entry("saved"))
        _, cold = await cache_for(prompt)
        self.assertIsNone(cold.get_local("series.source"))
        OBSERVATIONS.append({"id": "persistence-boundary", "stableSha256": first, "freshCacheHasPriorOutput": False, "note": "Stable external key is not disk persistence. BasicCache is memory-only without a separately configured provider."})

    async def test_C10_external_cache_provider_failure_does_not_destroy_local_output(self):
        class FailingProvider(CacheProvider):
            def __init__(self):
                self.lookups = 0
                self.stores = 0

            async def on_lookup(self, context):
                self.lookups += 1
                raise RuntimeError("injected external cache unavailable")

            async def on_store(self, context, value):
                self.stores += 1
                raise RuntimeError("injected external cache write failure")

        provider = FailingProvider()
        register_cache_provider(provider)
        register_cache_provider(provider)
        self.assertEqual(len(_get_cache_providers()), 1)
        _, cache = await cache_for(graph(), providers=True)
        self.assertIsNone(await cache._get_immediate("series.source"))
        await cache._set_immediate("series.source", cache_entry("local success"))
        await asyncio.gather(*list(cache._pending_store_tasks))
        self.assertEqual(cache.get_local("series.source").outputs, ["local success"])
        self.assertEqual((provider.lookups, provider.stores), (1, 1))
        unregister_cache_provider(provider)
        self.assertEqual(len(_get_cache_providers()), 0)
        OBSERVATIONS.append({"id": "provider-failure", "lookupErrorsHandled": 1, "storeErrorsHandled": 1, "localOutputRetained": True})

    async def test_C11_cache_is_content_based_not_project_partitioned(self):
        prompt = graph()
        _, cache = await cache_for(prompt)
        cache.set_local("series.source", cache_entry("project-A source"))
        renamed, _ = add_graph_prefix(prompt, (), "project-B:")
        await cache_for(renamed, existing=cache)
        self.assertEqual(cache.get_local("project-B:series.source").outputs, ["project-A source"])
        OBSERVATIONS.append({"id": "project-isolation-boundary", "sameInputDifferentNodePrefixReusesCache": True, "note": "Intentional content-based caching; separate tenants/projects require caller-level cache partitioning when isolation is required."})

    async def test_C12_external_unblock_once_and_duplicate_call_observation(self):
        dynamic, cache = await cache_for(graph())
        schedule = ExecutionList(dynamic, cache)
        schedule.add_node("series.board")
        release = schedule.add_external_block("series.source")
        before = schedule.blockCount["series.source"]
        release(["ready"])
        self.assertEqual(schedule.externalBlocks, 0)
        self.assertEqual(schedule.blockCount["series.source"], before - 1)
        self.assertEqual(schedule.get_external_block_result("series.source"), ["ready"])
        release(["duplicate"])
        self.assertEqual(schedule.externalBlocks, -1)
        self.assertEqual(schedule.blockCount["series.source"], -1)
        OBSERVATIONS.append({"id": "callback-idempotency-boundary", "afterDuplicateRelease": {"externalBlocks": schedule.externalBlocks, "sourceBlockCount": schedule.blockCount["series.source"]}, "note": "Original release callback is not idempotent; an HTTP/event adapter must prevent duplicate release. This is an observed missing guarantee, not a documented API promise."})

    async def test_C13_uncacheable_types_and_nan_are_detected(self):
        self.assertIsNone(_serialize_cache_key(object()))
        self.assertTrue(_contains_self_unequal({"value": float("nan")}))
        self.assertFalse(_contains_self_unequal({"value": 1}))


class JsonResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.details = []

    def startTest(self, test):
        self.started = time.perf_counter()
        super().startTest(test)

    def record(self, test, status, error=None):
        entry = {"id": test._testMethodName.split("_")[1], "name": test._testMethodName, "status": status, "duration_ms": round((time.perf_counter() - self.started) * 1000, 2)}
        if error:
            entry["error"] = self._exc_info_to_string(error, test)
        self.details.append(entry)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "passed")

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.record(test, "failed", error)

    def addError(self, test, error):
        super().addError(test, error)
        self.record(test, "error", error)


if __name__ == "__main__":
    if "--hash-probe" in sys.argv:
        print(hash_probe())
        raise SystemExit(0)
    logs = io.StringIO()
    handler = logging.StreamHandler(logs)
    logging.getLogger().addHandler(handler)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RealComfyTests)
    result = unittest.TextTestRunner(verbosity=2, resultclass=JsonResult).run(suite)
    modules = []
    for name, module in sorted(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if file:
            location = Path(file)
            if location.is_relative_to(SOURCE) and location.suffix == ".py":
                modules.append({"module": name, "file": str(location.relative_to(SOURCE)).replace("\\", "/"), "sha256": hashlib.sha256(location.read_bytes()).hexdigest()})
    report = {
        "suite": "Actual ComfyUI graph, dependency scheduler, input-signature cache and cache-provider boundaries",
        "repository": "https://github.com/Comfy-Org/ComfyUI", "commit": COMMIT,
        "checks": result.details,
        "summary": {"passed": sum(c["status"] == "passed" for c in result.details), "failed": len(result.failures), "errors": len(result.errors)},
        "observations": OBSERVATIONS, "capturedWarnings": logs.getvalue(), "sourceFiles": modules,
        "pristine": subprocess.check_output(["git", "status", "--porcelain"], cwd=SOURCE, text=True).strip() == "",
        "runtime": {"python": sys.version, "python_isolated_mode": sys.flags.isolated, "torch": importlib.metadata.version("torch"), "typing_extensions": importlib.metadata.version("typing_extensions"), "packaging": importlib.metadata.version("packaging")},
        "installedPackages": [],
        "boundaries": [
            "nodes.NODE_CLASS_MAPPINGS uses deterministic legacy numeric fixtures; no diffusion nodes or model weights.",
            "comfy/comfy_types and comfy_api/latest package initializers bypassed via namespace paths; original node_typing, internal marker classes, _caching dataclasses imported.",
            "Unused V3 _io.get_finalized_class_inputs is a guard that raises if called; V3 node support not tested.",
            "Unused model_patcher and system_memory functions are guards that raise if called; RAM-pressure/model/GPU behavior not tested.",
            "Existing real torch 2.10.0+cpu, typing_extensions and packaging imported read-only; no global installation or modifications.",
            "Cached output values are protocol fixtures; execution.CacheEntry and PromptExecutor are not imported.",
            "C04 explicitly calls original unstage/stage; this is not evidence of an automatic retry or billing system.",
            "C10 injects a failing external provider; no network provider or persistent disk storage used."
        ],
        "limitations": ["No full ComfyUI server, /prompt endpoint, database, UI or GPU inference launched.", "No model quality, production isolation or crash recovery claim.", "No upstream implementation replaced, patched or copied into harness."],
    }
    reports = BASE / "reports"
    reports.mkdir(exist_ok=True)
    (reports / "comfy-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"commit": COMMIT, "summary": report["summary"], "actualModules": [entry["module"] for entry in modules]}, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
