# PDF.js vendor files

The Hyatt tracker uses the version-pinned legacy browser builds from Mozilla PDF.js 5.6.205:

- `pdf-5.6.205.min.mjs`
- `pdf.worker-5.6.205.min.mjs`

They are declared as Tampermonkey resources and initialized only for the explicit statement-PDF backfill/import feature. See `LICENSE` for the Apache-2.0 license.
