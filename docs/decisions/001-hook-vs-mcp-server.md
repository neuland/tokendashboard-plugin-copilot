# ADR-001: Copilot CLI Hook over MCP Server

## Decision
Token usage is captured via the Copilot CLI hook system (`sessionStart`, `sessionEnd`, etc., configured under `hooks` in `~/.copilot/settings.json`), not an MCP server.

## Why
- Hooks fire automatically on every session with no model decision involved, giving gap-free, zero-effort tracking.
- An MCP server would require the model to actively decide to call a logging tool — not automatic, and gaps are likely.
- Trade-off: the agent itself has no access to the logged data. A query interface ("how many tokens this week?") would need an MCP server as a second component.

## Alternatives considered
Hybrid (hook for capture + MCP server for querying) — worth adding later only if a query interface is needed.
