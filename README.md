# mc-protocol-diff

A visual diff tool for Minecraft protocol changes.

## How it works

This tool tracks protocol updates from [derklaro/mc-protocol](https://github.com/derklaro/mc-protocol) and presents them as structured, filterable diffs - showing exactly which packets changed, what fields were added/removed/retyped, and which packet IDs shifted between any two Minecraft versions.

### Architecture

- **`main` branch** - Sync scripts (Python) and GitHub Actions workflow
- **`gh-pages` branch** - Static website (`index.html`) and pre-parsed protocol data (`data/`)

A GitHub Action runs hourly, checks for new protocol updates, parses the raw markdown into structured JSON, and commits the results to `gh-pages`. The website loads these JSON files directly - no GitHub API calls at runtime, no rate limits, no tokens needed.

### Features

- **Two-column diff view** - Clientbound (S→C) and Serverbound (C→S) side by side
- **Semantic packet diffing** - Added, removed, modified, renamed, relocated packets with field-level detail
- **Type change detection** - Identifies patterns like `Holder<>` wrapping and `Optional<>` wrapping
- **Field reorder detection** - Flags when field indices changed even if types didn't
- **Via-chain mode** - Shows step-by-step evolution across multiple intermediate versions
- **Raw markdown toggle** - View the original markdown source per packet
- **Keyboard navigation** - `j`/`k` navigate, `Enter` expand, `Shift+E`/`C` expand/collapse all
- **URL state** - Shareable deep links with version pair, filters, and search
- **JSON export** - Download diffs as structured or flat JSON for scripting
- **Collapsible groups** - Fold connection states you're not working on
- **Tooltips** - Hover any filter chip or toggle for a plain-language explanation

## Local development

### Running the sync manually

```bash
pip install -r requirements.txt
python sync.py --output data/
```

This populates a local `data/` directory with all protocol versions as JSON files.

### Serving the website locally

```bash
cd gh-pages/
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Data format

Each version produces a JSON file (`data/stable/1.20.5.json`) containing:

```json
{
  "version": "1.20.5",
  "kind": "stable",
  "sha": "...",
  "date": "2024-04-23T...",
  "protocol": "766",
  "sections": [
    {
      "stateName": "Game",
      "direction": "Clientbound",
      "packets": [
        {
          "idHex": "0x43",
          "name": "Remove Mob Effect",
          "fields": [
            { "name": "entityId", "full": "int" },
            { "name": "effect", "full": "Holder<MobEffect>" }
          ]
        }
      ]
    }
  ],
  "rawBlocks": {
    "clientbound|removemobeffect": "#### 0x43 - Remove Mob Effect (S ➔ C)\n..."
  }
}
```

The `rawBlocks` field maps a normalized key (`direction|packetname`) to the original markdown text of that packet section - used by the "raw markdown" toggle in the UI.

## Credits

- Protocol data: [derklaro/mc-protocol](https://github.com/derklaro/mc-protocol)