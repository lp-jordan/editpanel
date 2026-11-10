/**
 * Cut-through angle rules (Jordan 2026-11-10): "never cut from X to Y", set per multicam.
 * Shared by the Cut-through page (live checks in the Angle rules dialog, loaded as a plain
 * <script>, global `AngleRules`) and the main process (validation before saving / planning).
 *
 * A rule is "Camera 2>Camera 3" (directional). The placer treats them as hard rules
 * (place_cuts.py nocut=), Claude is told them.
 */
(function (root) {
  const SEP = '>';
  const key = (a, b) => `${a}${SEP}${b}`;
  const split = (r) => String(r).split(SEP);

  /** Rules kept only between two of these angles, deduped, sorted. */
  function clean(rules, angles) {
    const ok = new Set(angles || []);
    const out = new Set();
    for (const r of rules || []) {
      const [a, b] = split(r);
      if (a && b && a !== b && ok.has(a) && ok.has(b)) out.add(key(a, b));
    }
    return [...out].sort();
  }

  /**
   * angles: the usable angles (no "Don't use"), roles: {angle: wide|closeup|slider|side|other}.
   * Returns {errors: [text], warnings: [text]}; errors block saving.
   */
  function check(angles, rules, roles = {}) {
    const A = [...(angles || [])];
    const no = new Set(clean(rules, A));
    const can = (a, b) => a !== b && !no.has(key(a, b));
    const errors = [];
    const warnings = [];
    if (A.length < 2) return { errors, warnings };
    for (const a of A) {
      if (!A.some((b) => can(a, b))) errors.push(`${a} can't cut to any angle, so a removal on it has nowhere to go`);
      if (!A.some((b) => can(b, a))) errors.push(`No angle can cut to ${a}, so it would never be used`);
    }
    if (!errors.length) {
      const wide = A.find((a) => roles[a] === 'wide') || A[0];
      const seen = new Set([wide]);
      const q = [wide];
      while (q.length) {
        const a = q.shift();
        for (const b of A) if (can(a, b) && !seen.has(b)) { seen.add(b); q.push(b); }
      }
      const lost = A.filter((a) => !seen.has(a));
      if (lost.length) errors.push(`The wide can't lead to ${lost.join(', ')}`);
      const back = A.filter((a) => {
        const s = new Set([a]);
        const qq = [a];
        while (qq.length) {
          const x = qq.shift();
          for (const b of A) if (can(x, b) && !s.has(b)) { s.add(b); qq.push(b); }
        }
        return !s.has(wide);
      });
      if (back.length) errors.push(`${back.join(', ')} can't get back to the wide`);
    }
    const of = (r) => A.filter((a) => roles[a] === r);
    for (const s of of('side')) {
      for (const w of of('wide')) {
        if (no.has(key(w, s)) || no.has(key(s, w))) warnings.push(`${s} is a side angle, which usually comes in from the wide and goes back to it`);
      }
    }
    for (const s of of('slider')) {
      for (const c of of('closeup')) {
        if (no.has(key(c, s))) warnings.push(`${s} is a slider, which usually comes in from the close-up`);
      }
    }
    return { errors, warnings: [...new Set(warnings)] };
  }

  const api = { clean, check, key, split };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AngleRules = api;
})(typeof window !== 'undefined' ? window : this);
