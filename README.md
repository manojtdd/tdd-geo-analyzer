# GEO Analyzer by TripleDart

Score any webpage across 36 GEO checks and 6 categories. Export results to Google Sheets with color-coded rule breakdowns.

## Install

[Chrome Web Store link — add once published]

## Features

- **36 rules** across 6 categories: Content Quality, E-E-A-T Signals, Structured Data, Formatting, Conversational & AI-Friendly, Technical & Freshness
- **Scores 0–100** with letter grade (A+ through F)
- **Issues + Passing tabs** with per-rule detail and priority indicators
- **Export to Google Sheets** — creates a new spreadsheet per run with:
  - *Summary* tab: overall score, grade, category breakdown
  - *Rule Details* tab: all 36 rules with Pass/Partial/Fail color coding

## Local Development

1. Clone this repo
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select this folder
4. Copy the **Extension ID** shown on the card
5. Follow `SETUP_GOOGLE_SHEETS.txt` to create an OAuth client ID for your Extension ID
6. Paste the client ID into `manifest.json` under `oauth2.client_id` → reload the extension

> **Note:** Each developer who loads the extension unpacked gets a different Extension ID and needs their own OAuth client ID for local Sheets testing. See `SETUP_GOOGLE_SHEETS.txt`.

## Contributing

PRs welcome. The 36 scoring rules live in `background/background.js`.  
Add new rules to the `RULES` array following the existing pattern.

## License

MIT
