# Setting up EditPanel on a new machine

Audience: editors getting a fresh Windows + DaVinci Resolve workstation
ready to run EditPanel.

## Prerequisites (per machine)

1. **DaVinci Resolve Studio** installed and licensed.
   - The free build does not work — no scripting endpoint.
   - Open Resolve at least once before EditPanel's first launch so any
     license / onboarding flows are complete.

Python is **not** a prerequisite as of editpanel **1.2.1** — a pinned
Python 3.10 ships inside the installer. See "Why Python is bundled"
below.

## Install path

1. **Get access.** An LPOS admin grants the user EditPanel access via
   **Settings → EditPanel Access** in LPOS. After that, an EditPanel icon
   appears on the user's LPOS home screen (above the star/wish button).
2. **Download.** Click the EditPanel icon → opens `/ep-update` → download
   the latest Windows `.exe`. LPOS's `EpReleaseService` polls the shared
   NAS folder every 30s and serves the newest build.
3. **Install.** The installer is unsigned, so SmartScreen will warn —
   "More info" → "Run anyway". Default install dir is fine.
4. **First launch.** Click **Sign in**. EditPanel opens the LPOS SSO page
   in the system browser; approve, and the `lpos-editpanel://` callback
   brings you back into EditPanel with an `X-EP-Token` stored. From then
   on it's connected.

## Troubleshooting

### "Resolve disconnected" / advisory banner persists

Check, in order:

1. **Resolve Studio is actually running** before EditPanel tries to
   connect. The status bar shows "Offline" until Resolve is up.
2. **External Scripting is set to "Local"** in Resolve →
   **Preferences → System → General → External scripting using → Local**.
3. **Studio, not the free build.** The free build has no scripting
   endpoint.
4. **Repair the Resolve install** if 1–3 are correct. A corrupted
   `fusionscript.dll` from a prior install can survive a normal
   uninstall/reinstall — the in-place repair from Resolve's installer is
   the cleanest fix.

### Historical: "two competing Python installs" failure

**Resolved as of 1.2.1 — cannot recur.** Recording the failure mode here
for posterity.

Before 1.2.1, EditPanel used the system Python on PATH. On the lp2
machine (2026-06-02), two Python installs (3.10 + 3.11) coexisted;
fusionscript.dll loaded into the wrong one and segfaulted (`0xC0000005`
exit 3221225477) inside `PyInit`. Fix at the time was deleting the older
install.

This entire class of failures — wrong-version Python, two competing
installs, Microsoft Store sandbox Python, 32/64-bit ABI mismatch — is
eliminated by bundling. If a future machine reproduces the historical
AV crash signature on a clean 1.2.1+ install, it is not a Python issue.

## Why Python is bundled

EditPanel 1.2.1 ships a pinned Python 3.10 (the embeddable distribution
from python.org) via electron-builder `extraResources`. The Resolve
worker spawns the bundled interpreter explicitly, ignoring whatever's on
the system PATH. Single source of truth, ABI-locked against
`fusionscript.dll`, no install-time prompts.

Spawn path:
- **Packaged Windows build:** `<resourcesPath>/python/python.exe` (the
  bundled 3.10 from `vendor/python-win32/`).
- **Dev on macOS:** `python3` from PATH. macOS dev cannot reproduce the
  lp2 failure mode and packaging from macOS is unsupported anyway.
- **Dev on Windows:** the bundled `vendor/python-win32/python.exe` if it
  exists (`npm install` fetches it), else `python` on PATH.

The fetch lives in `scripts/fetch-python.mjs`, wired as a `postinstall`
hook in `package.json`. It downloads
`python-3.10.11-embed-amd64.zip` from python.org, verifies the MD5
against python.org's published value, extracts to `vendor/python-win32/`,
and patches `python310._pth` to add `..` plus `import site` (so the
bundled interpreter can find `helper/` at runtime — `_pth` files
override `PYTHONPATH` entirely, so the dir hint has to live in the file
itself).

`vendor/` is gitignored — the embeddable zip is re-fetched on
`npm install`. Don't commit it.

## Build & ship (for maintainers)

On the Windows build box:

```powershell
cd C:\lp-app-ecosystem\editpanel
git pull
npm install            # postinstall fetches Python 3.10 if vendor/ is empty
# Bump package.json version FIRST — EpReleaseService is idempotent and
# only picks up new versions. See docs/project history.md 2026-05-29.
$env:EP_RELEASE_OUT = "N:\LPOS\editpanel dist"
npm run package
```

LPOS picks up the new `.exe` within 30s. Target machines auto-prompt for
the update.

## Related docs

- `docs/project history.md` 2026-06-02 entries — the lp2 saga in full.
- `docs/architecture-baseline.md` — overall editpanel architecture.
- `docs/export-and-delivery.md` — export queue + render pipeline.
- `docs/lpos-contract.md` — EditPanel ↔ LPOS API contract.
