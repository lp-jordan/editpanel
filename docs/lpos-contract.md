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

## Review comments (Resolve marker tether)

`GET /api/ep/projects/:projectId/assets/:assetId/comments` (X-EP-Token auth)
returns, per comment: `id`, `frameioCommentId`, `text`, `authorName`,
`timestamp`, `completed`, `replies[]`, etc.

Identity model (Frame.io comment-decoupling Step 3, 2026-06): `id` is ALWAYS the
stable local LPOS `comment_id`; `frameioCommentId` is a separate, nullable field
carrying the Frame.io comment id. Previously `id` was `frameio_comment_id ??
comment_id` and "flipped" to the Frame.io id once the outbound mirror landed —
that flip is gone.

EditPanel tethers its Resolve timeline markers on the **Frame.io** comment id
(`custom_data` tag `frameio:{frameioCommentId}`), so it keys the marker pipeline
(`_formatTargetComment` → `sync_comment_markers` / `delete_comment_marker`) on
`frameioCommentId`, NOT `id`. The route filters out comments with a null
`frameioCommentId`, but EditPanel still guards defensively and skips marker
placement when it is missing.

The mark-complete PATCH (`.../comments/:commentId`) accepts either id, so
EditPanel passes the same `frameioCommentId` it already keys markers on.
