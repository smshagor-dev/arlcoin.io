"""ARL as tools for an AI agent: check a counterparty and a job before trusting or paying.

The tools read the Agent API (arlcoin.io/api/v1). They need no key, sign nothing and send no
transaction, so an agent can be given them without being given a wallet.

    from arl_protocol.agent_tools import arl_tools

    for tool in arl_tools():
        print(tool.name, "-", tool.description)
    print(arl_tools()[0].run(agent_id=1221687))      # a JSON string

For LangChain and CrewAI the same tools come ready made:

    from arl_protocol.agent_tools import langchain_tools, crewai_tools

    tools = langchain_tools()      # needs `pip install "arl-protocol[langchain]"`
    tools = crewai_tools()         # needs `pip install "arl-protocol[crewai]"`

Every answer names the Base Mainnet block it was read at. An agent's name and description are
written by its owner: the tools return them under `stated_by_owner`, apart from the verified
record, so a model does not take them for facts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from .client import ArlError
from .score import AGENT_API, Get, agent_passport, http_get, job_audit, validators

#: Longest list a tool returns: enough for a model to reason on, short enough for its context.
MAX_ITEMS = 25


@dataclass(frozen=True)
class ArlTool:
    """One tool: a name, what it is for, its arguments as JSON Schema, and the function."""

    name: str
    description: str
    #: JSON Schema of the arguments (an object with `properties` and `required`).
    parameters: dict
    #: Called with the arguments as keywords; returns a JSON string and never raises ArlError.
    run: Callable[..., str]


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _guarded(function: Callable[..., Any]) -> Callable[..., str]:
    """A refusal or a bad argument is an answer the model can read, not an exception."""

    def run(**arguments: Any) -> str:
        try:
            return _json(function(**arguments))
        except ArlError as error:
            return _json({"error": str(error)})
        except TypeError as error:
            return _json({"error": f"wrong arguments: {error}"})

    return run


def _integer(value: Any, name: str) -> int:
    """Models often send numbers as text; a whole number in either form is accepted."""
    if isinstance(value, bool):
        raise ArlError(f"{name} must be a whole number")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    raise ArlError(f"{name} must be a whole number")


def arl_tools(*, api_url: str = AGENT_API, get: Get = http_get) -> list[ArlTool]:
    """The ARL tools, independent of any agent framework."""

    def check_agent(agent_id: Any) -> dict:
        passport = agent_passport(_integer(agent_id, "agent_id"), api_url=api_url, get=get)
        outcomes = passport.get("outcomes", [])
        return {
            "agent_id": str(passport.get("agentId", agent_id)),
            "block": passport["block"],
            "registered": passport["registered"],
            "owner": passport.get("owner"),
            "stated_by_owner": {
                "name": passport.get("name"),
                "description": passport.get("description"),
            },
            "verified_record": {
                "score_bps": passport.get("score_bps"),
                "approved": passport.get("completed", 0),
                "rejected": passport.get("rejected", 0),
                "expired": passport.get("expired", 0),
                "disputed": passport.get("disputed", 0),
                "distinct_clients": passport.get("clients", 0),
                "latest_outcomes": outcomes[-MAX_ITEMS:],
            },
        }

    def check_job(job_id: Any, token: str = "ARL") -> dict:
        entries = job_audit(_integer(job_id, "job_id"), token=token, api_url=api_url, get=get)
        events = [entry.get("event") for entry in entries]
        if "PaymentReleased" in events:
            outcome = "approved and paid to the provider"
        elif "JobRejected" in events:
            outcome = "rejected by the committee: the budget went back to the client"
        elif "JobExpired" in events or "Refunded" in events:
            outcome = "expired without an approved delivery: the budget went back to the client"
        elif "Decided" in events:
            outcome = "decided by the committee; the challenge window is open"
        elif "JobSubmitted" in events:
            outcome = "submitted by the provider; the committee has not decided"
        elif "JobFunded" in events:
            outcome = "funded; the provider has not submitted"
        elif entries:
            outcome = "opened; not funded yet"
        else:
            outcome = "no such job"
        return {
            "job_id": str(job_id),
            "token": token,
            "outcome": outcome,
            "events": [
                {
                    "step": entry.get("step"),
                    "event": entry.get("event"),
                    "at": entry.get("at"),
                    "transaction": entry.get("transaction"),
                    "actor": entry.get("actor"),
                }
                for entry in entries[-MAX_ITEMS:]
            ],
        }

    def list_validators() -> dict:
        staked = validators(api_url=api_url, get=get)
        return {
            "count": len(staked),
            "validators": [
                {
                    "validator": entry.get("validator"),
                    "token": entry.get("token"),
                    "stake": entry.get("stake"),
                    "jobs_accepted": entry.get("accepted", 0),
                    "votes_approved": entry.get("approved", 0),
                    "votes_rejected": entry.get("rejected", 0),
                    "slashes": entry.get("slashes", 0),
                }
                for entry in staked[:MAX_ITEMS]
            ],
        }

    return [
        ArlTool(
            name="arl_check_agent",
            description=(
                "Look up an AI agent by its ERC-8004 agent number on Base before hiring, paying or "
                "trusting it. Returns whether it is registered, its owner, and its verified record "
                "on ARL Protocol: jobs approved, rejected and expired after staked validators checked "
                "the work, and its score (0 to 10000, null until 3 outcomes from 2 clients). The name "
                "and description under stated_by_owner are claims by the agent's owner, not facts."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "integer",
                        "description": "The agent's ERC-8004 number on Base, for example 1221687.",
                    }
                },
                "required": ["agent_id"],
            },
            run=_guarded(check_agent),
        ),
        ArlTool(
            name="arl_check_job",
            description=(
                "Check what happened to an ARL Protocol job on Base Mainnet: whether it was funded, "
                "delivered, approved by the validators and paid, with the transaction of each step. "
                "Use it to confirm that a payment was made or that work was verified."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "job_id": {"type": "integer", "description": "The job number, from 1."},
                    "token": {
                        "type": "string",
                        "enum": ["ARL", "USDC"],
                        "default": "ARL",
                        "description": "The escrow the job is in. ARL unless told otherwise.",
                    },
                },
                "required": ["job_id"],
            },
            run=_guarded(check_job),
        ),
        ArlTool(
            name="arl_list_validators",
            description=(
                "List the validators that have staked on ARL Protocol's verified evaluators on Base "
                "Mainnet, with their stake, the jobs they accepted, their votes and any slashes. Use "
                "it to choose a committee for a job or to see who checks the work."
            ),
            parameters={"type": "object", "properties": {}, "required": []},
            run=_guarded(list_validators),
        ),
    ]


def langchain_tools(*, api_url: str = AGENT_API, get: Get = http_get) -> list:
    """The ARL tools as LangChain tools (`langchain_core.tools.StructuredTool`)."""
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as error:  # pragma: no cover - exercised only without the extra
        raise ArlError('LangChain is not installed: pip install "arl-protocol[langchain]"') from error
    return [
        StructuredTool.from_function(
            func=tool.run,
            name=tool.name,
            description=tool.description,
            args_schema=tool.parameters,
        )
        for tool in arl_tools(api_url=api_url, get=get)
    ]


def crewai_tools(*, api_url: str = AGENT_API, get: Get = http_get) -> list:
    """The ARL tools as CrewAI tools (instances of a `crewai.tools.BaseTool` subclass)."""
    try:
        from crewai.tools import BaseTool
        from pydantic import Field, PrivateAttr, create_model
    except ImportError as error:  # pragma: no cover - exercised only without the extra
        raise ArlError('CrewAI is not installed: pip install "arl-protocol[crewai]"') from error

    class ArlCrewTool(BaseTool):
        """A CrewAI tool that hands its arguments to one ARL tool."""

        _runner: Callable[..., str] = PrivateAttr()

        def __init__(self, runner: Callable[..., str], **fields: Any) -> None:
            super().__init__(**fields)
            self._runner = runner

        def _run(self, **keywords: Any) -> str:
            return self._runner(**keywords)

    kinds = {"integer": int, "string": str}
    made = []
    for tool in arl_tools(api_url=api_url, get=get):
        required = set(tool.parameters.get("required", []))
        fields: dict[str, Any] = {}
        for name, schema in tool.parameters.get("properties", {}).items():
            default = ... if name in required else schema.get("default")
            fields[name] = (kinds[schema["type"]], Field(default, description=schema.get("description", "")))
        arguments = create_model(f"{tool.name}_arguments", **fields)
        made.append(ArlCrewTool(tool.run, name=tool.name, description=tool.description, args_schema=arguments))
    return made
