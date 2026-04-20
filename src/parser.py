"""Parser for mc-protocol readme.md files.

Extracts structured protocol data from the markdown format used by
derklaro/mc-protocol on the gh-pages branch.
"""

import html
import re
from typing import Any


def parse_readme(text: str) -> dict[str, Any]:
    """Parses a readme.md into structured protocol data.

    Args:
        text: Raw markdown content of readme.md.

    Returns:
        Dictionary with keys: title, protocol, worldVersion, javaVersion,
        resourcePackVersion, dataPackVersion, buildTime, sections.
    """
    lines = text.split("\n")
    result: dict[str, Any] = {
        "title": None,
        "protocol": None,
        "worldVersion": None,
        "javaVersion": None,
        "resourcePackVersion": None,
        "dataPackVersion": None,
        "buildTime": None,
        "sections": [],
    }

    section = None
    pkt = None
    in_table = False
    header_passed = False
    expect_meta_header = False
    expect_meta_dashes = False
    expect_meta_row = False

    h1_rx = re.compile(r"^#\s+(.+?)\s*$")
    sec_rx = re.compile(r"^##\s+(.+?)\s*$")
    pkt_rx = re.compile(
        r"^####\s+0x([0-9A-Fa-f]+)\s+-\s+(.+?)(?:\s+\(([^)]+)\))?\s*$"
    )
    nofld_rx = re.compile(r"^Packet has no fields", re.IGNORECASE)

    for line in lines:
        # H1 title — handle both formats:
        #   New: "# 1.20.5 (Stable)"
        #   Old: "# Snapshot 22w44a (1.19.3), Protocol 106 (1073741930), ..."
        if section is None and result["title"] is None:
            m = h1_rx.match(line)
            if m:
                raw_title = m.group(1).strip()
                result["title"] = raw_title
                # Try to extract protocol from old format H1
                proto_match = re.search(
                    r"Protocol\s+(\d+)", raw_title
                )
                if proto_match and result["protocol"] is None:
                    result["protocol"] = proto_match.group(1)
                expect_meta_header = True
                continue

        # Metadata table (only present in newer format)
        if expect_meta_header and re.match(r"^\|\s*Series\s*\|", line, re.IGNORECASE):
            expect_meta_header = False
            expect_meta_dashes = True
            continue
        # If we hit a section header while still expecting meta, there's no table
        if expect_meta_header and re.match(r"^##\s+", line):
            expect_meta_header = False
            # Fall through to section handling below

        if expect_meta_dashes and re.match(r"^\|\s*-+", line):
            expect_meta_dashes = False
            expect_meta_row = True
            continue
        if expect_meta_row and line.startswith("|"):
            cells = _split_cells(line)
            if len(cells) >= 8:
                result["javaVersion"] = cells[2]
                result["protocol"] = cells[3]
                result["worldVersion"] = cells[4]
                result["resourcePackVersion"] = cells[5]
                result["dataPackVersion"] = cells[6]
                result["buildTime"] = cells[7]
            expect_meta_row = False
            continue

        # Section header — handle both formats:
        #   New: "## Game (Clientbound)"
        #   Old: "## Handshaking (Client -> Server)" / "## Play (Server -> Client)"
        sm = sec_rx.match(line)
        if sm:
            full = sm.group(1).strip()
            # New format: "Game (Clientbound)" / "Game (Serverbound)"
            dm = re.match(r"^(.+?)\s*\((Serverbound|Clientbound)\)\s*$", full)
            if not dm:
                # Old format: "Play (Server -> Client)" / "Handshaking (Client -> Server)"
                dm_old = re.match(
                    r"^(.+?)\s*\((Server\s*->\s*Client|Client\s*->\s*Server)\)\s*$",
                    full,
                )
                if dm_old:
                    state_name = dm_old.group(1).strip()
                    raw_dir = dm_old.group(2).strip()
                    direction = (
                        "Clientbound"
                        if "server" in raw_dir.lower().split("->")[0].strip()
                        else "Serverbound"
                    )
                else:
                    state_name = full
                    direction = None
            else:
                state_name = dm.group(1).strip()
                direction = dm.group(2)

            section = {
                "fullName": full,
                "stateName": state_name,
                "direction": direction,
                "packets": [],
            }
            result["sections"].append(section)
            pkt = None
            in_table = False
            header_passed = False
            continue

        # Packet header
        pm = pkt_rx.match(line)
        if pm and section is not None:
            raw_name = pm.group(2).strip()
            # Strip trailing "Packet" suffix uniformly
            name = re.sub(r"\s*Packet\s*$", "", raw_name, flags=re.IGNORECASE)
            pkt = {
                "id": int(pm.group(1), 16),
                "idHex": "0x" + pm.group(1).upper().zfill(2),
                "name": name,
                "dir": pm.group(3).strip() if pm.group(3) else None,
                "fields": [],
                "noFields": False,
            }
            section["packets"].append(pkt)
            in_table = False
            header_passed = False
            continue

        if pkt is None:
            continue

        if nofld_rx.match(line):
            pkt["noFields"] = True
            continue

        if re.match(r"^\|\s*Index\s*\|", line, re.IGNORECASE):
            in_table = True
            header_passed = False
            continue

        if in_table and re.match(r"^\|\s*-+", line):
            header_passed = True
            continue

        if in_table and header_passed and line.startswith("|"):
            cells = _split_cells(line)
            if len(cells) >= 5:
                pkt["fields"].append({
                    "idx": cells[0],
                    "typeIdx": cells[1],
                    "name": html.unescape(cells[2]),
                    "raw": html.unescape(cells[3]),
                    "full": html.unescape(cells[4]),
                })
            continue

        if in_table and not line.startswith("|") and line.strip():
            in_table = False
            header_passed = False

    return result


def extract_raw_markdown(text: str) -> dict[str, str]:
    """Extracts raw markdown blocks per packet.

    Returns a dict mapping normalized packet key to the raw markdown text
    of that packet section (header line + table).

    Key format: "{direction_lower}|{packet_name_lower_stripped}"
    """
    lines = text.split("\n")
    blocks: dict[str, str] = {}
    section_dir = None

    sec_rx = re.compile(r"^##\s+(.+?)\s*$")
    pkt_rx = re.compile(
        r"^####\s+0x[0-9A-Fa-f]+\s+-\s+(.+?)(?:\s+\([^)]+\))?\s*$"
    )

    i = 0
    while i < len(lines):
        line = lines[i]

        sm = sec_rx.match(line)
        if sm:
            full = sm.group(1).strip()
            dm = re.match(r"^(.+?)\s*\((Serverbound|Clientbound)\)\s*$", full)
            if dm:
                section_dir = dm.group(2).lower()
            else:
                # Old format: "Play (Server -> Client)"
                dm_old = re.match(
                    r"^(.+?)\s*\((Server\s*->\s*Client|Client\s*->\s*Server)\)\s*$",
                    full,
                )
                if dm_old:
                    raw_dir = dm_old.group(2).strip()
                    section_dir = (
                        "clientbound"
                        if "server" in raw_dir.lower().split("->")[0].strip()
                        else "serverbound"
                    )
                else:
                    section_dir = None
            i += 1
            continue

        pm = pkt_rx.match(line)
        if pm:
            raw_name = pm.group(1).strip()
            name = re.sub(r"\s*Packet\s*$", "", raw_name, flags=re.IGNORECASE)
            name_key = re.sub(r"[\s\-_]+", "", name.lower())
            key = f"{section_dir or 'unknown'}|{name_key}"

            captured = [line]
            i += 1
            while i < len(lines):
                next_line = lines[i]
                if sec_rx.match(next_line) or pkt_rx.match(next_line):
                    break
                captured.append(next_line)
                i += 1

            # Trim trailing empty lines
            while captured and not captured[-1].strip():
                captured.pop()

            blocks[key] = "\n".join(captured)
            continue

        i += 1

    return blocks


def _split_cells(line: str) -> list[str]:
    """Splits a markdown table row into trimmed cell values."""
    parts = line.split("|")
    # Drop first and last empty segments from leading/trailing |
    return [p.strip() for p in parts[1:-1]]
