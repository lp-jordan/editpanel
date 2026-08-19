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

### Coverage: all versions, all assets behind a timeline (2026-08-19)

The route reads **every version** of the asset, not just the current one, and
freshens each version's thread from Frame.io before returning. A re-render mints
a new asset version and a new Frame.io file, so notes stay pinned to the cut the
reviewer was watching; the old current-version-only read made those invisible to
EditPanel (the LPOS browser UI has version chips to compensate — EditPanel has
no such control). Each comment therefore also carries:

- `assetVersionId` — the version the note was left on
- `versionNumber` — that version's number, or `null` if unknown
- `isCurrentVersion` — false when the note came from a superseded cut

and the response carries `currentVersionId` + `versionCount`.

EditPanel closes the matching gap on its side: a timeline uid can be tethered to
more than one LPOS asset (each re-render pushed as its own asset), so the pull
now queries **all** of them and merges by `frameioCommentId`, newest render
winning. Notes from a superseded cut get a `[vN]` suffix on the Resolve marker
name and an "older cut" badge in the pull report — they may already have been
actioned in a later render.
