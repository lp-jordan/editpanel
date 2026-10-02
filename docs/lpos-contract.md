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
returns **every** comment on the asset from the LPOS comments system
(`media_comments`), whatever its source: the LPOS UI, an LP Share link, or the
legacy Frame.io import. Per comment: `id`, `text`, `authorName`, `timestamp`,
`completed`, `replies[]`, version fields (below), and `frameioCommentId`
(legacy, nullable).

`id` is the stable LPOS `comment_id` and is the marker tag: EditPanel writes
`custom_data` = `lpos:{id}` (`_formatTargetComment` → `sync_comment_markers` /
`delete_comment_marker`). Frame.io plays no part in the pull or in Mark done.

**Legacy markers (before 2026-10-02)** were tagged `frameio:{frameioCommentId}`.
EditPanel sends each comment's `frameioCommentId` as `legacyCommentId`, and
`sync_comment_markers` re-tags a matching legacy marker in place (same frame,
colour, name, note) instead of duplicating it. Legacy markers with no open
comment are removed. `delete_comment_marker` tries both tags. Older EditPanel
builds still key on `frameioCommentId` and simply don't see LPOS-only comments.

The Mark done PATCH (`.../comments/:commentId`) writes the LPOS comment only
(LP Share picks it up on its next sync). It accepts the LPOS id, or a legacy
Frame.io id from reports saved by older builds.

### Coverage: all versions, all assets behind a timeline (2026-08-19)

The route reads **every version** of the asset, not just the current one. A
re-render mints a new asset version, so notes stay pinned to the cut the
reviewer was watching; the old current-version-only read made those invisible to
EditPanel (the LPOS browser UI has version chips to compensate — EditPanel has
no such control). Each comment therefore also carries:

- `assetVersionId` — the version the note was left on
- `versionNumber` — that version's number, or `null` if unknown
- `isCurrentVersion` — false when the note came from a superseded cut

and the response carries `currentVersionId` + `versionCount`.

EditPanel closes the matching gap on its side: a timeline uid can be tethered to
more than one LPOS asset (each re-render pushed as its own asset), so the pull
now queries **all** of them and merges by comment `id`, newest render
winning. Notes from a superseded cut get a `[vN]` suffix on the Resolve marker
name and an "older cut" badge in the pull report — they may already have been
actioned in a later render.
