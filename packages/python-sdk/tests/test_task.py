"""arl-task/1: the Python hash equals the TypeScript reference on every vector."""

import json
from pathlib import Path

import pytest

from arl_protocol.task import CanonicalError, canonicalize, task_hash

VECTORS = Path(__file__).resolve().parents[3] / "spec" / "arl-task" / "v0.1.0" / "vectors.json"


def load():
    return json.loads(VECTORS.read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", load()["valid"], ids=lambda v: v["name"])
def test_task_hash_matches_the_reference(vector):
    assert task_hash(vector["task"]) == vector["taskHash"]


def test_canonical_form():
    assert canonicalize({"b": 1, "a": [True, None, "ü\n"]}) == '{"a":[true,null,"ü\\n"],"b":1}'


def test_refuses_floats_and_wrong_versions():
    with pytest.raises(CanonicalError):
        canonicalize({"x": 1.5})
    with pytest.raises(CanonicalError):
        task_hash({"version": "arl-task/0"})


def test_keys_and_strings_hash_exactly_as_typescript():
    # Security report 2026-11-20: keys went through json.dumps with ensure_ascii, and lone
    # surrogates raised. Expected hashes are @arl/protocol canonicalHash of the same documents.
    cases = [
        (
            {"version": "arl-task/1", "title": "t", "a\x7fb": 1},
            "0x64104ea5a64cf78d6b686686189947cf8cc20228320c430ebb27a21d145bce76",
        ),
        (
            {"version": "arl-task/1", "title": "x\ud800y"},
            "0xc6c83f39cb1929ad69e65c4f1296790e915c31a4a21822601c752f10b3df81ce",
        ),
        (
            {"version": "arl-task/1", "title": "é\x7f "},
            "0xe830860dfd7c6bd42b4e6f7ebf2e277286a425a80ce3e8b8e06d93ce576b2475",
        ),
    ]
    for doc, expected in cases:
        assert task_hash(doc) == expected
