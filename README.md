# Chase Card Tracker Userscripts

Two local-first Tampermonkey userscripts built on one shared Chase transaction core:

- **Ink Tracker** tracks Chase Ink bonus-category spend, cardmember-year caps, and verified or estimated Ultimate Rewards points.
- **Hyatt Card Elite Night Tracker** tracks World of Hyatt personal and business card spend toward elite-night thresholds.

Created by **Robo** ([@robo77](https://discord.com/app) on Discord).

## Install

- [Install or update Ink Tracker](https://robo-tools.github.io/ink-tracker/ink-tracker.user.js)
- [Install or update Hyatt Card Elite Night Tracker](https://robo-tools.github.io/ink-tracker/hyatt-tracker.user.js)

After installation, sign in to Chase, open the Accounts dashboard, open the tracker using its floating button, and choose **Refresh**.

Both trackers visit each supported card’s Chase summary route, select **All transactions**, load every activity row Chase exposes, and restore the page where the refresh began. They stage the refresh and commit new totals only after every selected card completes.

## Ink Tracker

Ink Tracker:

- Tracks Ink Business Cash 5× spend against its $25,000 cardmember-year cap.
- Supports Ink Business Preferred 3× / $150,000 and uncapped Ink Unlimited/Premier summaries.
- Imports Ultimate Rewards transaction details as the authoritative earn-rate and points layer.
- Uses exact Ultimate Rewards points when every posted purchase in the displayed period is matched; otherwise it clearly displays an estimate.
- Stores a separate anniversary month/day for every card.
- Includes summary, detailed transaction review, CSV import, JSON export, and coverage diagnostics.

If you do not know a card’s anniversary date, open Chase’s **Secure Message Center** and ask for the cardmember anniversary date for that card’s last four digits.

During a complete refresh, the tab visibly moves between Chase and Ultimate Rewards because they are separate authenticated applications. The tracker automatically returns to Chase and reopens its results.

## Hyatt Card Elite Night Tracker

The Hyatt tracker supports the current personal and business World of Hyatt cards.

### Personal card

- Includes the card’s 5 annual qualifying-night credits.
- Tracks 2 additional qualifying-night credits for every $5,000 in purchases.
- Preserves the rolling lifetime remainder across calendar years.
- Assigns threshold crossings to the calendar year in which the qualifying spend posted.
- Separately tracks the $15,000 calendar-year spend requirement for the additional Category 1–4 free-night award.

The personal card requires one initialization method:

1. **Complete history:** enter the date the current Hyatt benefits began and confirm that no earlier qualifying purchases are missing. The tracker calculates lifetime net spend modulo $5,000.
2. **Exact Chase baseline:** enter a date and the amount already accumulated—or the amount remaining—toward the next two nights. A Chase secure message can be used to request this information.
3. **Last award date:** enter the last known two-night award or threshold date. This remains visibly labeled as an estimate because the threshold-crossing purchase may have left unknown rollover.

The setup screen compares the benefit start date with the oldest captured transaction. A first purchase up to 60 days after opening is treated as a normal setup gap, but the user must still confirm that no earlier purchase is missing before the result is labeled exact.

### Business card

- Tracks 5 qualifying-night credits for every $10,000 in purchases during the calendar year.
- Resets the counter every January 1.
- Requests a simple confirmation only when activity before the oldest captured current-year transaction cannot be verified automatically.

The Hyatt tracker calculates card-derived qualifying nights. Nights from hotel stays, promotions, or another source are not available in the Chase export and are not included.

Chase and Hyatt make the final determination of qualifying purchases and benefits. The scripts exclude payments, pending charges, fees, and common cash-like transactions and subtract identified returns or refunds.

## Accuracy and coverage

The trackers distinguish among:

- Chase-confirmed transaction or rewards data.
- User-confirmed full-history or baseline coverage.
- Merchant/category inference.
- Explicitly incomplete or estimated coverage.

The oldest transaction is not automatically treated as the start of an account. A card may have existed before its first purchase, so the Hyatt tracker asks a concrete question about earlier purchases rather than assuming that the transaction list proves the opening date.

CSV imports accept standard Chase activity exports containing date, description, type, amount, and category columns. CSV rows are reconciled with Chase DOM and network versions of the same transaction while preserving legitimate repeated purchases.

Pending transactions are excluded until they post. Partial Chase activity or Ultimate Rewards lists are rejected rather than saved as complete data.

## Privacy

Neither userscript has external network permission or analytics. Data is stored separately for each tracker through Tampermonkey storage, or same-origin local storage during development.

Only normalized card and transaction fields are persisted: product name, last four digits, transaction date, description, amount, category, and app-specific setup or points metadata. Raw responses, full card numbers, cookies, credentials, authentication tokens, and saved Chase HTML are never persisted by the userscripts.

Saved banking pages can contain private data, so `chaseHTML/` remains gitignored.

## Shared architecture

```text
packages/chase-core/
  lib/       CSV, dates, normalization, and matching
  app/       Chase activity navigation, network capture, storage, and reconciliation

apps/ink/    Ink product rules, calculations, Ultimate Rewards parsing, UI, and entry point
apps/hyatt/  Hyatt product rules, calculations, setup, UI, and entry point
```

The shared core is a build-time dependency. Each generated `.user.js` is self-contained and does not load executable code from GitHub while the user is signed into Chase. The trackers use separate storage keys and can be installed independently or together.

## Updates and releases

Tampermonkey checks the small `.meta.js` file for each installed tracker and downloads its corresponding `.user.js` only when the version increases:

- `dist/ink-tracker.meta.js` → `dist/ink-tracker.user.js`
- `dist/hyatt-tracker.meta.js` → `dist/hyatt-tracker.user.js`

Development work belongs on `main`. A version tag such as `v1.0.0` runs all tests, builds both userscripts, verifies every version declaration, and publishes only `dist/` through GitHub Pages.

## Development

```sh
npm test
npm run build
npm run check
npm run verify-release -- v1.0.0
```

The build uses only Node.js and has no package dependencies.
