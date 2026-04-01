# LD+JSON Article Reader

Chrome extension prototype that scans the active tab for LD+JSON metadata, extracts article-like nodes, and opens the selected result in a clean reading view.

## Features

- Manifest V3 extension with no build step.
- Popup to scan the active tab using `chrome.scripting.executeScript`.
- Candidate ranking loaded from an external config file.
- Manual selection when multiple LD+JSON nodes are available.
- Clean reader page for `articleBody`, with fallback raw metadata view.
- Heuristic paragraph and subtitle formatting for flat article text without line breaks.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.

## Current flow

1. Open a page that contains LD+JSON metadata.
2. Click the extension action.
3. Scan the current tab.
4. Choose a candidate and open the reader.

## Notes

- The extractor walks nested LD+JSON objects and arrays, including `@graph` structures.
- If no `articleBody` is available, the extension still lets you inspect the metadata node in the reader.
- Ranking and formatting values live in `article-reader.config.json`.
- `siteProfiles` is empty by default. If you want per-site ranking tweaks, add them in the config file instead of modifying the popup code.
- Subtitle recovery from plain text is heuristic. If the source `articleBody` has no structural markers, the reader can only infer likely headings from sentence length and capitalization patterns.