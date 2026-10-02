# GSAP Browser Build

`gsap.min.js` is the unmodified GSAP 3.15.0 browser distribution from the exact
dependency pinned in the root package.json/package-lock.json. Its copyright and
license notice are retained in the file header. GSAP uses the
[GSAP standard license](https://gsap.com/standard-license/).

After installing dependencies, run `npm run vendor:gsap` to refresh this file.
Commit the resulting browser build so Python-only installations work offline.
No plugins or CDN requests are required. Application behavior remains available
when the optional library cannot load; only entrance fades are skipped.
