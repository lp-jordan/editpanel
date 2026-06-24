#!/usr/bin/env python3
"""
DaVinci Resolve scripting loader (bundled, self-contained).

Replaces the community python_get_resolve.py that delegated to
Blackmagic's DaVinciResolveScript.py wrapper installed at
%PROGRAMDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\Modules\\.
That folder is created by an *optional* Studio installer component
(Scripting Samples / Developer Documentation), which means a perfectly
working Resolve Studio install can still be missing it — and the old
loader would then fall through to a misleading import error.

The only file we depend on finding on the user's machine is the native
endpoint `fusionscript.dll` (Windows) / `fusionscript.so` (Mac/Linux),
which always ships with any Resolve install. Everything above it is
our code now.

Windows specifics: since Python 3.8 the native-DLL loader no longer
searches PATH for an extension module's dependent DLLs. fusionscript.dll
has hard runtime deps on other Resolve libraries that live alongside it
in the install dir; without `os.add_dll_directory()` pointing there, the
load succeeds at the symbol level but the first call into scriptapp()
access-violates inside a missing dependent. That was the failure mode
that drove the rewrite — see [[editpanel_resolve_advisory]].
"""

from __future__ import annotations

import faulthandler
import importlib.machinery
import importlib.util
import logging
import os
import sys
import time

# Dump a Python traceback to stderr if the interpreter segfaults — including
# crashes inside native module initialization. Without this, an access
# violation inside fusionscript.dll's PyInit just kills the process with no
# clue which Python frame triggered it. The stderr stream is forwarded to
# the EditPanel UI, so the dump shows up in the slideout console.
try:
    faulthandler.enable()
except Exception:
    pass

logger = logging.getLogger(__name__)

# Default fusionscript path per platform. Always overridable via the
# RESOLVE_SCRIPT_LIB env var (the one Blackmagic env var still worth
# honoring after the rewrite — it's the only piece of state we can't
# predict from a default install).
_DEFAULT_LIB_PATHS = {
    'win32':  r'C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll',
    'cygwin': r'C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll',
    'darwin': '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so',
    'linux':  '/opt/resolve/libs/Fusion/fusionscript.so',
}


def _resolve_lib_path() -> str:
    """Pick the fusionscript binary path to load."""
    env = os.environ.get('RESOLVE_SCRIPT_LIB')
    if env:
        return env
    for key, default in _DEFAULT_LIB_PATHS.items():
        if sys.platform.startswith(key):
            return default
    raise RuntimeError(f"Unsupported platform for Resolve scripting: {sys.platform}")


def _prepare_dll_search() -> None:
    """
    Windows-only: tell Python's native loader to also look in Resolve's
    install dir when resolving fusionscript.dll's dependent DLLs. No-op
    on other platforms and on Python <3.8 (which still uses PATH).
    """
    if not (sys.platform.startswith('win') or sys.platform.startswith('cygwin')):
        return
    if not hasattr(os, 'add_dll_directory'):
        # Python 3.7 or earlier — falls back to PATH-based lookup which
        # still works on older Windows.
        return
    try:
        lib = _resolve_lib_path()
    except RuntimeError as exc:
        logger.warning("Can't determine Resolve lib path: %s", exc)
        return
    resolve_dir = os.path.dirname(lib)
    if not os.path.isdir(resolve_dir):
        logger.warning("Resolve install dir not present: %s", resolve_dir)
        return
    try:
        os.add_dll_directory(resolve_dir)
        logger.info("Added Resolve DLL search dir: %s", resolve_dir)
    except OSError as exc:
        logger.warning("add_dll_directory failed for %s: %s", resolve_dir, exc)


# Log the interpreter context once at module import. fusionscript.dll
# is a Python C extension built against a specific CPython ABI — when
# the load segfaults inside loader.exec_module() and our DLL search dir
# is correctly set, the next thing to suspect is an interpreter
# version/bitness mismatch. Capturing this here means future failure
# logs include exactly what we need to diagnose without asking.
logger.info(
    "Python interpreter: %s (%d-bit) at %s",
    sys.version.split()[0],
    64 if sys.maxsize > 2**32 else 32,
    sys.executable,
)

# Wire the DLL search at import time so it's in place for the first
# GetResolve() call. resolve_helper.py imports this module on startup;
# the actual native DLL doesn't load until GetResolve() runs.
_prepare_dll_search()


_script_module = None  # cached after first successful load


def _load_fusionscript():
    """Load fusionscript.{dll,so} as a Python extension module."""
    global _script_module
    if _script_module is not None:
        return _script_module

    lib_path = _resolve_lib_path()
    if not os.path.isfile(lib_path):
        raise FileNotFoundError(
            f"fusionscript not found at {lib_path}. "
            "Confirm DaVinci Resolve Studio is installed; if it's installed "
            "somewhere other than the default location, set RESOLVE_SCRIPT_LIB "
            "to the full path of fusionscript.dll (Windows) / fusionscript.so "
            "(Mac/Linux)."
        )

    loader = importlib.machinery.ExtensionFileLoader('fusionscript', lib_path)
    spec = importlib.util.spec_from_loader('fusionscript', loader, origin=lib_path)
    if spec is None:
        raise ImportError(f"Could not build module spec for {lib_path}")

    # Log right before the native load so we know which DLL the loader tried
    # even when it access-violates. This MUST come before module_from_spec():
    # for a C-extension, module_from_spec() -> loader.create_module() is where
    # the .dll/.so is mapped in and its PyInit_* runs, so that's the call that
    # access-violates on an ABI/version mismatch (exec_module() for a
    # single-phase extension is effectively a no-op afterward). Logging after
    # module_from_spec() meant this line never printed on the exact failure it
    # was meant to diagnose — a silent process death with no DLL identity.
    try:
        st = os.stat(lib_path)
        logger.info(
            "Attempting native load: %s (size=%d bytes, mtime=%s)",
            lib_path, st.st_size, time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(st.st_mtime)),
        )
    except OSError as exc:
        logger.info("Attempting native load: %s (stat failed: %s)", lib_path, exc)
    sys.stderr.flush()

    module = importlib.util.module_from_spec(spec)  # native PyInit runs here
    loader.exec_module(module)
    _script_module = module
    logger.info("Loaded fusionscript from %s", lib_path)
    return module


def GetResolve():
    """Return a connected Resolve app handle, or None if Resolve isn't running.

    Raises:
      FileNotFoundError: fusionscript.dll/.so not present at the expected path.
      ImportError: native loader failed (typically a dependent-DLL miss
        — check os.add_dll_directory wiring).
    """
    mod = _load_fusionscript()
    return mod.scriptapp('Resolve')
