# -*- coding: utf-8 -*-
"""Build the Z8 auto rough cut from the merged WhisperX transcript instead of Resolve's.

Same spike as spike_auto_rough_cut.py (build mode), using spikes/plans/Z8_whisperx_export.json
and Z8_whisperx_plan.json. Builds __SPIKE_auto_Z8_whisperx_<n>. Run in the Py3 console:
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_auto_rough_cut_whisperx.py", encoding="utf-8").read())
"""
TRANSCRIPT_OVERRIDE = "whisperx"
exec(open(r"C:\lp-app-ecosystem\editpanel\spikes\spike_auto_rough_cut.py", encoding="utf-8").read())
