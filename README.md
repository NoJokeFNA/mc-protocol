# mc-protocol-diff

A visual diff tool for [Minecraft protocol](https://github.com/derklaro/mc-protocol) changes, built for porting work
on [PacketEvents](https://github.com/retrooper/packetevents).

Compare any two Minecraft versions and instantly see which packets were added, removed, modified, renamed, or
relocated - with field-level detail, type change detection, and direct links to PacketEvents wrapper classes.

**[→ Open the tool](https://nojokefna.github.io/mc-protocol/)**

## Architecture

| Branch     | Content                                                    |
|------------|------------------------------------------------------------|
| `master`   | Python sync scripts (`src/`), GitHub Actions workflows, CI |
| `gh-pages` | Static website + pre-parsed protocol data (`data/`)        |

A GitHub Action runs hourly, checks [derklaro/mc-protocol](https://github.com/derklaro/mc-protocol) for new protocol
updates, parses the raw markdown into structured JSON, and commits the results to `gh-pages`. A second step
sparse-checkouts [PacketEvents](https://github.com/retrooper/packetevents) to extract wrapper class mappings. The
website loads these JSON files directly - no GitHub API calls at runtime, no rate limits, no tokens needed.

## Features

### Diff Engine

- **Two-column layout** - Clientbound (S→C) left, Serverbound (C→S) right, grouped by connection state
- **Five change types** - added, removed, modified, renamed, relocated - each with distinct color coding
- **Field-level diffing** - shows exactly which fields changed type, were added/removed, or were reordered
- **Type change pattern detection** - recognizes `Holder<>` wrapping, `Optional<>` wrapping, and other common patterns
- **Summary line** - algorithmic one-liner describing the most significant changes

### Via-Chain Mode

- Toggle to load **every intermediate version** between the selected pair
- Per-packet step-by-step evolution showing exactly *when* each change happened
- Version badge on every packet - even single-step changes show which version introduced the change
- **"Most changed" ranking** - summary highlights the top 3 packets with the most meaningful intermediate changes (
  relocated steps excluded), with packet direction (S→C / C→S), click to jump

### PacketEvents Integration

- Automatic lookup of the corresponding **PacketEvents wrapper class** for each packet
- Clickable badge linking directly to the wrapper source on GitHub
- Version-aware fallback: if PacketEvents doesn't have an exact match for the MC version, the nearest older mapping is
  used (dotted border indicates approximate match)
- Handles duplicate enum names across connection states (e.g. `KEEP_ALIVE` in Play vs. Configuration)

### UI & Navigation

- **Keyboard shortcuts** - `j`/`k` navigate, `Enter`/`Space` expand, `g`/`G` first/last, `Shift+E`/`C` expand/collapse
  all, `/` search, `Esc` close
- **Collapsible state groups** - fold connection states you're not working on
- **Filter chips** - click any change type badge to filter (click again to clear)
- **"Only breaking" toggle** - hides cosmetic changes, shows only added/removed/modified
- **Search** - filter packets by name or field name/type
- **URL state** - shareable deep links preserving version pair, filters, search, and toggle states
- **Raw markdown toggle** - view the original protocol markdown per packet
- **JSON export** - download the current diff as structured (grouped) or flat (array) JSON
- **Toast notifications** - non-intrusive status messages for Linkie lookups and errors

## Data Format

Each version produces a JSON file in `data/{stable,prerelease,snapshot}/{version}.json`:

```json
{
  "version": "1.21.6",
  "kind": "stable",
  "protocol": "770",
  "sections": [
    {
      "stateName": "Game",
      "direction": "Clientbound",
      "packets": [
        {
          "idHex": "0x43",
          "name": "Remove Mob Effect",
          "fields": [
            {
              "name": "entityId",
              "full": "int"
            },
            {
              "name": "effect",
              "full": "Holder<MobEffect>"
            }
          ]
        }
      ]
    }
  ],
  "rawBlocks": {
    ...
  }
}
```

The parser handles both the current readme format (`## Game (Clientbound)`) and the legacy format (
`## Play (Server -> Client)`) used by older protocol versions.

## Local Development

### Prerequisites

```bash
pip install -r requirements.txt
```

### Sync protocol data

```bash
cd src
python sync.py --output ../data/
```

### Generate PacketEvents wrapper mappings

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/retrooper/packetevents.git --branch 2.0
cd packetevents
git sparse-checkout set api/src/main/java/com/github/retrooper/packetevents/protocol/packettype
cd ..

python src/parse_packetevents.py \
  --source packetevents/api/src/main/java/com/github/retrooper/packetevents/protocol/packettype \
  --output data/packetevents.json
```

### Serve locally

Copy the `data/` folder into the `gh-pages` directory (or symlink), then:

```bash
cd gh-pages
python -m http.server 8000
```

Open `http://localhost:8000`.

## Credits

- Protocol data sourced from [derklaro/mc-protocol](https://github.com/derklaro/mc-protocol)
- Wrapper mappings from [PacketEvents](https://github.com/retrooper/packetevents)
- Built entirely by [Claude](https://claude.ai) (Anthropic)