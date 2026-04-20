#!/usr/bin/env python3
"""Parses PacketEvents Java source to extract packet type → wrapper class mappings.

Reads the PacketType.java file and all version-specific enum files to build
a complete mapping of packet IDs to PacketEvents wrapper classes.

Usage:
    python parse_packetevents.py --source /path/to/packettype/ --output packetevents.json
"""

import argparse
import json
import re
from pathlib import Path


def parse_packet_type_java(path: Path) -> dict:
    """Parses PacketType.java to extract enum-name → wrapper-class mappings.

    Returns a dict with keys for each state+side combination, each mapping
    enum names to their wrapper class names.
    """
    text = path.read_text(encoding="utf-8")
    result = {}

    # Parse Play.Client enum entries: NAME(WrapperClass.class),
    # Parse Play.Server enum entries
    # Parse Configuration.Client enum entries
    # Parse Configuration.Server enum entries
    # Parse Login.Client / Login.Server
    # Parse Status.Client / Status.Server
    # Parse Handshaking.Client

    sections = [
        ("play_serverbound",
         r"public enum Client implements PacketTypeCommon, ServerBoundPacket\s*\{(.*?)\n\s*private static int INDEX",),
        ("play_clientbound",
         r"public enum Server implements PacketTypeCommon, ClientBoundPacket\s*\{(.*?)\n\s*private static int INDEX",),
    ]

    # The Play.Client and Play.Server enums are the big ones.
    # We need to find them within the Play class context.
    # Strategy: find "public static class Play" then parse Client/Server enums inside it.

    # More robust: parse ALL enum entries that have a wrapper class pattern
    # Pattern: ENUM_NAME(WrapperSomething.class),  or  ENUM_NAME(null),
    wrapper_rx = re.compile(
        r"^\s*(?:@\w+(?:\.\w+)*\s*)*"  # optional annotations
        r"([A-Z][A-Z0-9_]+)"  # enum name
        r"\s*\("
        r"\s*(Wrapper\w+)\.class"  # wrapper class
        r"\s*\)",
        re.MULTILINE,
    )

    null_rx = re.compile(
        r"^\s*(?:@\w+(?:\.\w+)*\s*)*"
        r"([A-Z][A-Z0-9_]+)"
        r"\s*\(\s*null\s*\)",
        re.MULTILINE,
    )

    # We need to know which section (Play.Client, Play.Server, etc.) each enum belongs to.
    # Parse the file structurally by finding class/enum boundaries.

    wrappers = {}

    # Find all wrapper assignments
    for m in wrapper_rx.finditer(text):
        enum_name = m.group(1)
        wrapper_class = m.group(2)

        # Determine side and state from wrapper class name
        side, state = _classify_wrapper(wrapper_class)

        # Key includes side+state to handle duplicates like KEEP_ALIVE
        # appearing in Play.Client, Play.Server, Config.Client, etc.
        # We store BOTH the contextual key AND the plain enum name.
        ctx_key = f"{state}_{side}_{enum_name}" if side and state else enum_name
        wrappers[ctx_key] = {
            "enum": enum_name,
            "wrapper": wrapper_class,
            "side": side,
            "state": state,
        }

    # Also record null-wrapper enums (packets without wrappers)
    for m in null_rx.finditer(text):
        enum_name = m.group(1)
        # For null wrappers we can't determine context from the wrapper name,
        # so just store under the plain enum name (may be overwritten, that's ok)
        if enum_name not in wrappers:
            wrappers[enum_name] = {
                "enum": enum_name,
                "wrapper": None,
                "side": None,
                "state": None,
            }

    return wrappers


def _classify_wrapper(wrapper_name: str) -> tuple[str | None, str | None]:
    """Classifies a wrapper class name into (side, state).

    Examples:
        WrapperPlayClientKeepAlive → ("client", "play")
        WrapperPlayServerTimeUpdate → ("server", "play")
        WrapperConfigClientSettings → ("client", "configuration")
        WrapperLoginServerDisconnect → ("server", "login")
        WrapperStatusClientRequest → ("client", "status")
        WrapperHandshakingClientHandshake → ("client", "handshaking")
    """
    # Pattern: Wrapper{State}{Side}{Name}
    m = re.match(
        r"Wrapper(Play|Config|Login|Status|Handshaking)"
        r"(Client|Server)",
        wrapper_name,
    )
    if not m:
        return None, None

    state_map = {
        "Play": "play",
        "Config": "configuration",
        "Login": "login",
        "Status": "status",
        "Handshaking": "handshaking",
    }
    side_map = {
        "Client": "client",  # Client wrappers = packets FROM client = serverbound
        "Server": "server",  # Server wrappers = packets FROM server = clientbound
    }

    return side_map[m.group(2)], state_map[m.group(1)]


def parse_version_enum(path: Path) -> list[str]:
    """Parses a version-specific enum file (e.g. ServerboundPacketType_1_21_6.java).

    Returns the list of enum constant names in ordinal order.
    """
    text = path.read_text(encoding="utf-8")

    # Find all enum constants — they're uppercase identifiers before a comma or semicolon
    # We need to be careful to skip comments and annotations
    # Strategy: find the enum body, then extract constant names in order

    # Find "public enum XXX {" ... "}"
    enum_body_rx = re.compile(
        r"public\s+enum\s+\w+\s*\{(.*?)\n\s*\}",
        re.DOTALL,
    )
    m = enum_body_rx.search(text)
    if not m:
        return []

    body = m.group(1)

    # Extract enum constants: lines that start with an uppercase identifier
    # followed by comma, semicolon, or end of enum
    # Skip annotations (@...), comments (// ..., /* ... */), and blank lines
    constants = []
    for line in body.split("\n"):
        line = line.strip()
        # Skip empty, comments, annotations
        if not line or line.startswith("//") or line.startswith("/*") or line.startswith("*") or line.startswith("@"):
            continue
        # Match enum constant: NAME, or NAME; (last one)
        cm = re.match(r"^([A-Z][A-Z0-9_]+)\s*[,;]?\s*(?://.*)?$", line)
        if cm:
            constants.append(cm.group(1))

    return constants


def classify_enum_file(filename: str) -> tuple[str, str, str]:
    """Classifies a version enum filename into (direction, state, version).

    Examples:
        ServerboundPacketType_1_21_6.java → ("serverbound", "play", "1_21_6")
        ClientboundPacketType_1_21_6.java → ("clientbound", "play", "1_21_6")
        ServerboundConfigPacketType_1_20_5.java → ("serverbound", "configuration", "1_20_5")
        ClientboundConfigPacketType_1_20_5.java → ("clientbound", "configuration", "1_20_5")
    """
    name = filename.replace(".java", "")

    # Config packets
    m = re.match(r"(Serverbound|Clientbound)ConfigPacketType_(.*)", name)
    if m:
        direction = m.group(1).lower()
        version = m.group(2)
        return direction, "configuration", version

    # Play packets
    m = re.match(r"(Serverbound|Clientbound)PacketType_(.*)", name)
    if m:
        direction = m.group(1).lower()
        version = m.group(2)
        return direction, "play", version

    return "unknown", "unknown", "unknown"


def scan_version_enums(packettype_dir: Path) -> dict:
    """Scans all version-specific enum files in the packettype directory.

    Returns a nested dict: {state}_{direction} → {version} → [enum_names_in_order]
    """
    result = {}
    versions_by_key = {}

    # Scan all subdirectories for version enum files
    for java_file in sorted(packettype_dir.rglob("*.java")):
        name = java_file.name
        if not re.match(r"(Serverbound|Clientbound)(Config)?PacketType_", name):
            continue

        direction, state, version = classify_enum_file(name)
        key = f"{state}_{direction}"

        constants = parse_version_enum(java_file)
        if not constants:
            continue

        if key not in result:
            result[key] = {}
            versions_by_key[key] = []

        result[key][version] = constants
        versions_by_key[key].append(version)

    return result, versions_by_key


def build_packetevents_json(packettype_dir: Path) -> dict:
    """Builds the complete packetevents.json mapping structure."""
    # 1. Parse PacketType.java for wrapper class mappings
    packet_type_java = packettype_dir / "PacketType.java"
    if not packet_type_java.exists():
        raise FileNotFoundError(f"PacketType.java not found in {packettype_dir}")

    wrappers = parse_packet_type_java(packet_type_java)
    print(f"  Extracted {len(wrappers)} wrapper mappings from PacketType.java")

    # 2. Scan version-specific enum files
    mappings, versions_by_key = scan_version_enums(packettype_dir)
    total_versions = sum(len(v) for v in mappings.values())
    print(f"  Found {total_versions} version enum files across {len(mappings)} categories")

    # 3. Sort versions within each key by a smart version comparator
    for key in versions_by_key:
        versions_by_key[key] = sorted(
            versions_by_key[key],
            key=_version_sort_key,
        )

    # 4. Build the GitHub URL base for wrapper source links
    wrapper_base_url = (
        "https://github.com/retrooper/packetevents/blob/2.0/"
        "api/src/main/java/com/github/retrooper/packetevents/wrapper/"
    )

    # 5. Build wrapper URL paths from class names
    for enum_name, info in wrappers.items():
        wrapper = info.get("wrapper")
        if not wrapper:
            continue

        # Convert wrapper class name to path
        # WrapperPlayClientKeepAlive → play/client/WrapperPlayClientKeepAlive.java
        # WrapperConfigServerDisconnect → configuration/server/WrapperConfigServerDisconnect.java
        side = info.get("side")  # "client" or "server"
        state = info.get("state")  # "play", "configuration", "login", "status", "handshaking"

        if side and state:
            path_state = state
            if path_state == "handshaking":
                path_state = "handshaking"
            elif path_state == "configuration":
                path_state = "configuration"
            info["url"] = f"{wrapper_base_url}{path_state}/{side}/{wrapper}.java"

    return {
        "versions": versions_by_key,
        "mappings": mappings,
        "wrappers": wrappers,
    }


def _version_sort_key(version_str: str) -> tuple:
    """Sort key for version strings like '1_21_6', '1_7_10', '26_1'."""
    parts = version_str.split("_")
    return tuple(int(p) for p in parts if p.isdigit())


def main():
    arg_parser = argparse.ArgumentParser(
        description="Parse PacketEvents source to extract wrapper mappings"
    )
    arg_parser.add_argument(
        "--source", "-s",
        required=True,
        help="Path to the packettype/ directory in PacketEvents source",
    )
    arg_parser.add_argument(
        "--output", "-o",
        default="packetevents.json",
        help="Output JSON file path (default: packetevents.json)",
    )
    args = arg_parser.parse_args()

    source_dir = Path(args.source)
    if not source_dir.exists():
        print(f"Error: source directory not found: {source_dir}")
        return

    print("Parsing PacketEvents source...")
    data = build_packetevents_json(source_dir)

    output_path = Path(args.output)
    with open(output_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))

    size_kb = output_path.stat().st_size / 1024
    print(f"Written {output_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
