# Ink Tracker for Chase

A local-first Tampermonkey userscript that tracks Chase Ink bonus-category spend, card-anniversary caps, and estimated Ultimate Rewards points in a modal inspired by the supplied “Ways to Earn” reference.

Created by **Robo** ([@robo77](https://discord.com/app) on Discord).

## What it does

- Finds every Ink business card exposed in Chase’s Accounts page state.
- Visits each card’s Chase summary route, selects **All transactions**, loads every activity row Chase exposes online, and restores the page you started on.
- Tracks Ink Business Cash 5× spend against its $25,000 cardmember-year cap.
- Supports Ink Business Preferred 3× / $150,000 and uncapped Ink Unlimited/Premier summaries.
- Uses exact Ultimate Rewards points when every posted purchase in the displayed period is matched; otherwise it clearly falls back to an estimate.
- Stores a separate anniversary month/day for each card and shows the next reset.
- Shows summary and transaction-review views in a Shadow DOM modal so Chase styles cannot break it. Detailed review includes per-card filters, bonus-cap and unmatched views, exact points, and verification sources.
- Imports Chase CSV activity as an accuracy/backup path and exports tracker JSON.
- Imports Ultimate Rewards transaction details as the authoritative earn-rate and points layer.
- Automatically cycles through **Ultimate Rewards → Rewards Activity → All transactions** for every discovered Ink card in the current tab, then returns to Chase and reopens the tracker modal.
- Stages the complete refresh as one batch, keeping the dashboard stable and committing recalculated totals only after every card finishes.
- Reconciles Chase DOM, CSV, and network versions of the same transaction while preserving legitimate repeated purchases.
- Excludes pending transactions until they post and refuses to commit partial activity or Rewards lists.

## Install

1. Open the [hosted userscript](https://robo-tools.github.io/ink-tracker/ink-tracker.user.js) and approve the Tampermonkey installation.
2. Sign in to Chase and open the Accounts dashboard.
3. Click **⚡ Ink Tracker**, then **Refresh**. Keep that tab open while it cycles through Chase and Ultimate Rewards.
4. Click each “Anniversary needed” label and enter that card's anniversary date. The year is ignored; only month/day are stored.

If you do not know a card’s anniversary date, open Chase’s **Secure Message Center**, start a new message, and ask for the cardmember anniversary date for that card’s last four digits.

If you start Refresh directly on an Ultimate Rewards transaction-details page, the tracker still supports a one-card import. It auto-matches the page to a card when possible and asks for the last four digits when the match is ambiguous.

The tab visibly navigates because Chase’s authenticated activity and Ultimate Rewards interfaces are separate apps. When the completed sync returns to Chase, the userscript automatically reopens the results modal. The tracker does not submit payments, change settings, or call any non-Chase service.

## Accuracy model

Transaction categories are chosen in this order:

1. Chase-reported category captured from activity JSON or CSV.
2. Conservative merchant-name inference for common office, phone, internet, cable, shipping, travel, and advertising merchants.

Ultimate Rewards earn rates and points are matched separately by card, amount, posting date, and merchant similarity. A promotional earn rate can confirm points, but cannot make an unrelated purchase consume an office-supply or other category cap.

Merchant-inferred rows are labeled in the UI for review. Card anniversary dates are intentionally user-set because the saved Chase activity page does not expose a reliable account-open/anniversary field.

Confirmation and inference badges are scoped to the anniversary period currently displayed. The Debug view shows the earliest and latest dates actually available from Chase activity and Ultimate Rewards, plus whether Chase explicitly confirmed each list was complete. Prior-year totals should only be trusted when the displayed cardmember-year window falls inside complete activity coverage.

## Privacy

The userscript has no external network permission and contains no analytics. Data is stored only through Tampermonkey storage (or same-origin local storage in development). It persists normalized card and transaction fields, never raw Chase responses, cookies, credentials, tokens, or full card numbers.

Saved banking pages can contain private data, so `chaseHTML/` is gitignored.

## Updates

Tampermonkey checks the header-only [`dist/ink-tracker.meta.js`](dist/ink-tracker.meta.js) published through GitHub Pages and installs a newer [`dist/ink-tracker.user.js`](dist/ink-tracker.user.js) when its `@version` increases. Development work belongs on `main`; only tested releases should be promoted to `stable`. A GitHub Actions workflow tests and rebuilds the `stable` branch before publishing only the `dist/` directory.

Existing installations using the former local-only namespace should be removed before installing the hosted build once. Future versions will then update in place.

## Development

```sh
npm test
npm run build
npm run check
```

The build uses only Node.js and has no package dependencies.
