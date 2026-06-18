# OCG stabilization design

## Goal

Stabilize the current OpenCommandGo state without adding new product scope: close the pending CLI/runtime/documentation gaps, make the current watchdog and refresh behavior easier to reason about, and leave a clean handoff for the next session.

## Scope

- Keep the clean-install direction (`ocg`) with no migration layer.
- Preserve the current runtime model: local shim + OpenCode provider sync + watchdog.
- Improve confidence around current behavior through focused tests and operational docs.
- Track release workflows in the repository instead of leaving them as local-only files.

## Architecture impact

No architectural rewrite is needed. The changes stay in the current boundaries:

- `src/cli/main.js` remains the operator-facing entrypoint.
- `src/runtime/server.js` remains the OpenAI-compatible HTTP bridge.
- `src/watchdog/index.js` remains the background recovery process.
- `README.md` and session handoff docs become the operational source of truth.

## Implementation plan

1. Audit pending local changes and keep only the stabilization-related ones.
2. Extract tiny testable helpers from the CLI where useful, without changing runtime behavior.
3. Add focused tests for refresh arg parsing, watchdog restart counting, and current port/PID helpers.
4. Update README with the runtime lifecycle that now exists in code (`logs`, `reset`, watchdog, release workflows, probe warning).
5. Add a next-session handoff document with the verified status and remaining gaps.

## Error handling

- Do not change the network/runtime contract unless a defect is verified.
- Keep graceful shutdown first, force-kill fallback second.
- Keep probe warnings explicit because real availability checks spend credits.

## Testing

- Add/extend Node test coverage only.
- No build step after changes.
- Focus on deterministic helpers rather than flaky background-process integration in this stabilization pass.

## Remaining intentional gaps

- Full end-to-end CLI integration tests are still a next phase.
- Capability inference for some models still depends on upstream catalog quality and probes.
- Release workflows depend on repo secrets/branch policy outside this codebase.
