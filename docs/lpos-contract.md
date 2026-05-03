# EditPanel to LPOS Contract

EditPanel remains the Resolve-facing editorial client.

EditPanel owns:

- Resolve attach and timeline commands
- export initiation and write-back
- editorial operator workflows

LPOS owns:

- transcription runtime and queueing
- media pipeline state and reconciliation
- runtime dependency provisioning
- publish and asset-version state

During consolidation, EditPanel should call explicit LPOS APIs or queue handoff points for pipeline-owned operations rather than keeping duplicate local pipeline state.
