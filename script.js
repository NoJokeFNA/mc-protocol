/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
const DATA_BASE = 'data';

const app = {
    versions: [],                    // from versions.json
    versionCache: new Map(),         // sha -> parsed version data (from JSON files)
    packetEvents: null,              // from packetevents.json (wrapper mappings)
    fromSha: null,
    toSha: null,
    currentDiff: null,
    currentVersions: null,
    filter: {tag: 'all', state: 'all', search: '', breaking: false},
    includePre: false,
    viaChain: false,
    focusedPktEl: null,
    pktViewMode: new Map(),
    suppressUrlUpdate: false,
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ═══════════════════════════════════════════════════════════════════════════
   DATA LOADING — static JSON files, no API calls
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadVersionIndex() {
    setStatus('loading', 'loading version index…');
    const resp = await fetch(`${DATA_BASE}/versions.json`);
    if (!resp.ok) throw new Error(`Failed to load versions.json: ${resp.status}`);
    const data = await resp.json();
    // Sort by date ascending
    const versions = (data.versions || []).sort((a, b) => a.date.localeCompare(b.date));
    return versions.map(v => ({
        version: v.version,
        sha: v.sha,
        short: v.sha.slice(0, 7),
        date: new Date(v.date),
        kind: v.kind,
        protocol: v.protocol,
        file: v.file,
    }));
}

async function loadVersionData(versionInfo) {
    if (app.versionCache.has(versionInfo.sha)) return app.versionCache.get(versionInfo.sha);
    const url = `${DATA_BASE}/${versionInfo.file}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${versionInfo.file}: ${resp.status}`);
    const data = await resp.json();
    app.versionCache.set(versionInfo.sha, data);
    return data;
}

function unescHtml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/* ═══════════════════════════════════════════════════════════════════════════
   PACKETEVENTS WRAPPER LOOKUP
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadPacketEventsData() {
    try {
        const resp = await fetch(`${DATA_BASE}/packetevents.json`);
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/**
 * Resolves the best PacketEvents version enum for a given mc-protocol version.
 * Falls back to the nearest older PE version, same logic as VersionMapper in PacketEvents.
 *
 * @param {string} mcVersion - e.g. "1.21.6", "26.1-snapshot-1"
 * @param {string} key - e.g. "play_serverbound", "play_clientbound", "configuration_serverbound"
 * @returns {string|null} - PE version key like "1_21_6" or null
 */
function findPEVersion(mcVersion, key) {
    if (!app.packetEvents) return null;
    const peVersions = app.packetEvents.versions[key];
    if (!peVersions || !peVersions.length) return null;

    // Normalize mc-protocol version to PE format: "1.21.6" → "1_21_6", "26.1" → "26_1"
    // Strip snapshot/pre/rc suffixes for matching
    const stripped = mcVersion.replace(/-(?:pre|rc|snapshot).*$/i, '').replace(/\./g, '_');

    // Exact match first
    if (peVersions.includes(stripped)) return stripped;

    // Fallback: find the nearest older version
    // Compare by version tuple
    const targetParts = stripped.split('_').map(Number);
    let best = null;

    for (const pv of peVersions) {
        const pvParts = pv.split('_').map(Number);
        // Is pvParts <= targetParts?
        let isOlderOrEqual = true;
        for (let i = 0; i < Math.max(pvParts.length, targetParts.length); i++) {
            const a = pvParts[i] || 0, b = targetParts[i] || 0;
            if (a > b) {
                isOlderOrEqual = false;
                break;
            }
            if (a < b) break;
        }
        if (isOlderOrEqual) best = pv;
    }

    return best;
}

/**
 * Looks up the PacketEvents wrapper info for a packet by its ID in a specific version.
 *
 * @param {number} packetId - Packet ID (e.g. 0x1B = 27)
 * @param {string} mcVersion - MC version string (e.g. "1.21.6")
 * @param {string} direction - "Clientbound" or "Serverbound"
 * @param {string} stateName - Connection state name (e.g. "Game", "Play", "Configuration")
 * @returns {{ enumName: string, wrapper: string|null, url: string|null, peVersion: string }|null}
 */
function lookupWrapper(packetId, mcVersion, direction, stateName) {
    if (!app.packetEvents) return null;

    // Build the key: "play_serverbound", "configuration_clientbound", etc.
    const stateNorm = (stateName || '').toLowerCase();
    const state = (stateNorm === 'game' || stateNorm === 'play') ? 'play'
        : (stateNorm === 'config' || stateNorm === 'configuration') ? 'configuration'
            : stateNorm;
    const dir = (direction || '').toLowerCase();
    const key = `${state}_${dir}`;

    // Find the PE version for this mc version
    const peVersion = findPEVersion(mcVersion, key);
    if (!peVersion) return null;

    // Look up the enum at the packet's ordinal position
    const versionMappings = app.packetEvents.mappings[key];
    if (!versionMappings) return null;
    const enumList = versionMappings[peVersion];
    if (!enumList || packetId >= enumList.length) return null;

    const enumName = enumList[packetId];
    if (!enumName) return null;

    // Map direction to PE side: serverbound packets are "client" side wrappers,
    // clientbound packets are "server" side wrappers
    const peSide = dir === 'serverbound' ? 'client' : dir === 'clientbound' ? 'server' : null;

    // Look up the wrapper class using the contextual key: state_side_ENUM_NAME
    const ctxKey = peSide ? `${state}_${peSide}_${enumName}` : enumName;
    let wrapperInfo = app.packetEvents.wrappers[ctxKey];

    // Fallback: try plain enum name (for packets with null wrapper that don't have context)
    if (!wrapperInfo) wrapperInfo = app.packetEvents.wrappers[enumName];

    return {
        enumName,
        wrapper: wrapperInfo?.wrapper || null,
        url: wrapperInfo?.url || null,
        peVersion,
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DIFF
   ═══════════════════════════════════════════════════════════════════════════ */
const stateKey = sec => (sec.stateName || '').toLowerCase();
const dirKey = sec => (sec.direction || '').toLowerCase();

function groupBy(arr, keyFn) {
    const out = {};
    for (const x of arr) {
        const k = keyFn(x);
        (out[k] = out[k] || []).push(x);
    }
    return out;
}

function diffFields(bFields, aFields) {
    const bMap = new Map(bFields.map(f => [f.name.toLowerCase(), f]));
    const rows = [];
    let hasChanges = false;
    const seen = new Set();
    for (const f of aFields) {
        const k = f.name.toLowerCase();
        seen.add(k);
        const b = bMap.get(k);
        if (!b) {
            rows.push({state: 'added', after: f});
            hasChanges = true;
        } else {
            const typeChanged = b.full !== f.full;
            rows.push({state: typeChanged ? 'changed' : 'same', before: b, after: f});
            if (typeChanged) hasChanges = true;
        }
    }
    for (const f of bFields) {
        const k = f.name.toLowerCase();
        if (!seen.has(k)) {
            rows.push({state: 'removed', before: f});
            hasChanges = true;
        }
    }

    // Detect reordering: for fields present in both, check if their positions changed
    // Position = integer index in the array (not the "idx" string which can be weird)
    const reorderedFields = [];
    const bPositions = new Map();
    bFields.forEach((f, i) => bPositions.set(f.name.toLowerCase(), i));
    const aPositions = new Map();
    aFields.forEach((f, i) => aPositions.set(f.name.toLowerCase(), i));

    // Account for additions/removals shifting positions: we compare only the SUBSEQUENCE
    // of common field names. If their relative order differs, that's a genuine reorder.
    const commonInBeforeOrder = bFields.filter(f => aPositions.has(f.name.toLowerCase()));
    const commonInAfterOrder = aFields.filter(f => bPositions.has(f.name.toLowerCase()));
    if (commonInBeforeOrder.length === commonInAfterOrder.length && commonInBeforeOrder.length > 1) {
        for (let i = 0; i < commonInBeforeOrder.length; i++) {
            if (commonInBeforeOrder[i].name.toLowerCase() !== commonInAfterOrder[i].name.toLowerCase()) {
                reorderedFields.push({
                    name: commonInAfterOrder[i].name,
                    beforeIdx: commonInBeforeOrder.findIndex(f => f.name.toLowerCase() === commonInAfterOrder[i].name.toLowerCase()),
                    afterIdx: i,
                });
            }
        }
    }

    return {rows, hasChanges, reorderedFields};
}

function makeStateGroup(bSec, aSec, direction, totals) {
    const g = {
        direction,
        stateName: (aSec || bSec).stateName,
        oldStateName: (bSec && aSec && bSec.stateName !== aSec.stateName) ? bSec.stateName : null,
        packets: [],
    };
    const bPackets = bSec ? bSec.packets : [];
    const aPackets = aSec ? aSec.packets : [];
    const norm = p => p.name.toLowerCase().replace(/[\s\-_]+/g, '');
    const bMap = new Map(bPackets.map(p => [norm(p), p]));
    const aMap = new Map(aPackets.map(p => [norm(p), p]));
    const seen = new Set();

    for (const [k, a] of aMap) {
        if (bMap.has(k)) {
            seen.add(k);
            const b = bMap.get(k);
            const fd = diffFields(b.fields, a.fields);
            const idChanged = b.id !== a.id;
            const nameChanged = b.name !== a.name;
            const dirChanged = b.dir !== a.dir;
            let tag;
            if (fd.hasChanges || dirChanged) tag = 'modified';
            else if (fd.reorderedFields && fd.reorderedFields.length > 0) tag = 'modified';
            else if (nameChanged) tag = 'renamed';
            else if (idChanged) tag = 'relocated';
            else tag = 'unchanged';
            g.packets.push({before: b, after: a, tag, fieldDiff: fd, idChanged, nameChanged, dirChanged});
            totals[tag]++;
        }
    }
    for (const [k, a] of aMap) {
        if (!seen.has(k) && !bMap.has(k)) {
            g.packets.push({before: null, after: a, tag: 'added', fieldDiff: null});
            totals.added++;
        }
    }
    for (const [k, b] of bMap) {
        if (!aMap.has(k)) {
            g.packets.push({before: b, after: null, tag: 'removed', fieldDiff: null});
            totals.removed++;
        }
    }
    g.packets.sort((x, y) => (x.after?.id ?? x.before?.id ?? 999) - (y.after?.id ?? y.before?.id ?? 999));
    return g;
}

function diffProtocol(before, after) {
    const totals = {added: 0, removed: 0, modified: 0, renamed: 0, relocated: 0, unchanged: 0};
    const bByDir = groupBy(before.sections, dirKey);
    const aByDir = groupBy(after.sections, dirKey);
    const allDirs = new Set([...Object.keys(bByDir), ...Object.keys(aByDir)]);
    const groups = [];

    for (const dir of allDirs) {
        const bSecs = bByDir[dir] || [];
        const aSecs = aByDir[dir] || [];
        const bByState = new Map(bSecs.map(s => [stateKey(s), s]));
        const aByState = new Map(aSecs.map(s => [stateKey(s), s]));
        const handled = new Set();
        for (const [key, aSec] of aByState) {
            if (bByState.has(key)) {
                groups.push(makeStateGroup(bByState.get(key), aSec, dir, totals));
                handled.add(key);
            }
        }
        const unmatchedBefore = [...bByState.entries()].filter(([k]) => !aByState.has(k)).map(([, v]) => v);
        const unmatchedAfter = [...aByState.entries()].filter(([k]) => !handled.has(k)).map(([, v]) => v);
        const usedAfter = new Set();
        for (const b of unmatchedBefore) {
            const match = unmatchedAfter.find(a => !usedAfter.has(a));
            if (match) {
                usedAfter.add(match);
                groups.push(makeStateGroup(b, match, dir, totals));
            } else groups.push(makeStateGroup(b, null, dir, totals));
        }
        for (const a of unmatchedAfter) {
            if (!usedAfter.has(a)) groups.push(makeStateGroup(null, a, dir, totals));
        }
    }

    const stateOrder = ['handshake', 'handshaking', 'status', 'login', 'configuration', 'config', 'play', 'game'];
    groups.sort((a, b) => {
        const ai = stateOrder.indexOf(stateKey({stateName: a.stateName}));
        const bi = stateOrder.indexOf(stateKey({stateName: b.stateName}));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return {groups, totals, before, after};
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHAIN DIFF — shows each intermediate step for each packet between two versions
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Computes chain between fromSha and toSha by walking every intermediate version
 * and producing per-packet step entries. Returns a diff-like structure where each
 * packet carries a `chain` array: [{version, stepTag, delta}] describing each hop.
 */
async function diffProtocolChain(fromV, toV, intermediates) {
    // intermediates is the full ordered list including endpoints: [fromV, mid1, mid2, …, toV]
    // Parse all readmes in parallel
    const parsed = await Promise.all(intermediates.map(async v => {
        const data = await loadVersionData(v);
        return {version: v, parsed: data};
    }));

    // For each adjacent pair, compute a diff
    const adjacentDiffs = [];
    for (let i = 0; i < parsed.length - 1; i++) {
        adjacentDiffs.push({
            from: parsed[i].version,
            to: parsed[i + 1].version,
            diff: diffProtocol(parsed[i].parsed, parsed[i + 1].parsed),
        });
    }

    // Build a packet identity tracker across the chain:
    // For each packet in the final version, walk backwards through the chain
    // to figure out what happened to it over time. Use normalized-name tracking
    // but update the "tracked name" when a rename is detected, so we can follow
    // a packet across rename steps.
    const beforeFinal = parsed[0].parsed;
    const afterFinal = parsed[parsed.length - 1].parsed;
    const totalDiff = diffProtocol(beforeFinal, afterFinal);

    // For each packet in the total diff, attach its chain history
    for (const group of totalDiff.groups) {
        for (const pkt of group.packets) {
            if (pkt.tag === 'unchanged') continue;
            pkt.chain = buildPacketChain(pkt, adjacentDiffs);
        }
    }

    totalDiff.isChain = true;
    totalDiff.chainSteps = parsed.length - 1;
    totalDiff.chainVersions = intermediates;
    return totalDiff;
}

/**
 * For a single packet in the overall diff, walk the adjacent diffs and find
 * every step where THIS packet changed. Identity matching: start from the
 * current packet's final name/id and walk backwards, updating the identity
 * as we encounter renames.
 */
function buildPacketChain(packet, adjacentDiffs) {
    const steps = [];
    // Identity we're tracking, updated as we walk
    let trackedName = (packet.after || packet.before).name.toLowerCase().replace(/[\s\-_]+/g, '');
    let trackedDir = (packet.after || packet.before).dir;

    // Walk adjacent diffs from latest back to earliest
    // For each step, find a packet matching our tracked identity and record the change
    for (let i = adjacentDiffs.length - 1; i >= 0; i--) {
        const {from, to, diff} = adjacentDiffs[i];
        let found = null;
        let foundGroup = null;
        for (const g of diff.groups) {
            for (const p of g.packets) {
                const nm = (p.after || p.before).name.toLowerCase().replace(/[\s\-_]+/g, '');
                const dr = (p.after || p.before).dir;
                // Match by "after" identity because we're walking backwards
                if (p.after) {
                    const afterNm = p.after.name.toLowerCase().replace(/[\s\-_]+/g, '');
                    if (afterNm === trackedName && (!trackedDir || !p.after.dir || p.after.dir === trackedDir)) {
                        found = p;
                        foundGroup = g;
                        break;
                    }
                } else if (!p.after && p.before) {
                    // Removed packet — matches if tracked name equals its before name
                    const beforeNm = p.before.name.toLowerCase().replace(/[\s\-_]+/g, '');
                    if (beforeNm === trackedName) {
                        found = p;
                        foundGroup = g;
                        break;
                    }
                }
            }
            if (found) break;
        }

        if (found && found.tag !== 'unchanged') {
            steps.unshift({
                from, to,
                tag: found.tag,
                packet: found,
                groupName: foundGroup.stateName,
            });
            // Update identity for next (earlier) step: use the "before" name if it changed
            if (found.before && found.after && found.nameChanged) {
                trackedName = found.before.name.toLowerCase().replace(/[\s\-_]+/g, '');
            }
        }
    }
    return steps;
}

/* ═══════════════════════════════════════════════════════════════════════════
   URL STATE
   ═══════════════════════════════════════════════════════════════════════════ */
function encodeState() {
    const p = new URLSearchParams();
    if (app.fromSha) p.set('from', app.fromSha.slice(0, 10));
    if (app.toSha) p.set('to', app.toSha.slice(0, 10));
    if (app.filter.tag !== 'all') p.set('tag', app.filter.tag);
    if (app.filter.state !== 'all') p.set('state', app.filter.state);
    if (app.filter.search) p.set('q', app.filter.search);
    if (app.filter.breaking) p.set('breaking', '1');
    if (app.viaChain) p.set('chain', '1');
    if (app.includePre) p.set('pre', '1');
    return p.toString();
}

function updateUrl(replace = false) {
    if (app.suppressUrlUpdate) return;
    const qs = encodeState();
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    if (replace) history.replaceState(null, '', url);
    else if (location.search !== (qs ? `?${qs}` : '')) {
        history.pushState(null, '', url);
    }
}

function readUrl() {
    const p = new URLSearchParams(location.search);
    return {
        fromPrefix: p.get('from'),
        toPrefix: p.get('to'),
        tag: p.get('tag') || 'all',
        state: p.get('state') || 'all',
        q: p.get('q') || '',
        breaking: p.get('breaking') === '1',
        chain: p.get('chain') === '1',
        pre: p.get('pre') === '1',
    };
}

function resolveShaByPrefix(prefix) {
    if (!prefix) return null;
    const match = app.versions.find(v => v.sha.startsWith(prefix));
    return match ? match.sha : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */
function exportDiffAsJson(format) {
    if (!app.currentDiff || !app.currentVersions) return;
    const {from, to} = app.currentVersions;

    const base = {
        tool: 'mc-protocol-diff',
        exportedAt: new Date().toISOString(),
        from: {
            version: from.version,
            sha: from.sha,
            date: from.date.toISOString(),
            protocol: app.currentDiff.before.protocol
        },
        to: {version: to.version, sha: to.sha, date: to.date.toISOString(), protocol: app.currentDiff.after.protocol},
        totals: app.currentDiff.totals,
        chain: app.currentDiff.isChain ? {
            steps: app.currentDiff.chainSteps,
            versions: app.currentDiff.chainVersions.map(v => v.version),
        } : null,
    };

    let payload;
    if (format === 'structured') {
        payload = {
            ...base,
            groups: app.currentDiff.groups.map(g => ({
                direction: g.direction,
                stateName: g.stateName,
                oldStateName: g.oldStateName,
                packets: g.packets.filter(p => p.tag !== 'unchanged').map(serializePacket),
            })).filter(g => g.packets.length),
        };
    } else {
        // Flat: single array of packets with direction/state embedded
        const flat = [];
        for (const g of app.currentDiff.groups) {
            for (const p of g.packets) {
                if (p.tag === 'unchanged') continue;
                flat.push({
                    direction: g.direction,
                    state: g.stateName,
                    oldState: g.oldStateName,
                    ...serializePacket(p),
                });
            }
        }
        payload = {...base, packets: flat};
    }

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = `${from.version}_to_${to.version}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    a.href = url;
    a.download = `mc-protocol-diff-${slug}-${format}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
}

function serializePacket(p) {
    const out = {
        tag: p.tag,
        idHex: (p.after || p.before).idHex,
        name: (p.after || p.before).name,
        direction: (p.after || p.before).dir,
    };
    if (p.before) out.before = {
        idHex: p.before.idHex,
        name: p.before.name,
        fields: p.before.fields,
        noFields: p.before.noFields
    };
    if (p.after) out.after = {
        idHex: p.after.idHex,
        name: p.after.name,
        fields: p.after.fields,
        noFields: p.after.noFields
    };
    if (p.idChanged) out.idChanged = true;
    if (p.nameChanged) out.nameChanged = true;
    if (p.dirChanged) out.dirChanged = true;
    if (p.fieldDiff) out.fieldDelta = {
        added: p.fieldDiff.rows.filter(r => r.state === 'added').map(r => r.after),
        removed: p.fieldDiff.rows.filter(r => r.state === 'removed').map(r => r.before),
        changed: p.fieldDiff.rows.filter(r => r.state === 'changed').map(r => ({
            name: r.after.name,
            before: r.before.full,
            after: r.after.full
        })),
        reordered: p.fieldDiff.reorderedFields || [],
    };
    if (p.chain) out.chain = p.chain.map(s => ({
        from: s.from.version, to: s.to.version, tag: s.tag,
        packet: serializePacket(s.packet),
    }));
    return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RAW MARKDOWN — reads from pre-extracted rawBlocks in the version JSON
   ═══════════════════════════════════════════════════════════════════════════ */
async function getRawPacketMarkdown(versionInfo, direction, packetName) {
    if (!versionInfo) return null;
    try {
        const data = await loadVersionData(versionInfo);
        if (!data.rawBlocks) return null;
        // Build the lookup key: "direction|normalizedname"
        const dir = (direction || 'unknown').toLowerCase();
        const nameKey = packetName.toLowerCase().replace(/[\s\-_]+/g, '');
        const key = `${dir}|${nameKey}`;
        const md = data.rawBlocks[key];
        return md ? {markdown: md} : null;
    } catch {
        return null;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDERING
   ═══════════════════════════════════════════════════════════════════════════ */
function setStatus(kind, text) {
    $('#statusPill').className = 'status-pill ' + kind;
    $('#statusText').textContent = text;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function populateVersionPickers() {
    const visible = app.versions.filter(v => app.includePre || v.kind === 'stable');

    function opts(vers) {
        const byKind = {stable: [], prerelease: [], snapshot: []};
        for (const v of vers) byKind[v.kind].push(v);
        let html = '';
        if (byKind.stable.length) html += `<optgroup label="Stable">${byKind.stable.map(v => `<option value="${v.sha}">${esc(v.version)}</option>`).join('')}</optgroup>`;
        if (byKind.prerelease.length) html += `<optgroup label="Pre-releases / RCs">${byKind.prerelease.map(v => `<option value="${v.sha}">${esc(v.version)}</option>`).join('')}</optgroup>`;
        if (byKind.snapshot.length) html += `<optgroup label="Snapshots">${byKind.snapshot.map(v => `<option value="${v.sha}">${esc(v.version)}</option>`).join('')}</optgroup>`;
        return html;
    }

    const html = opts([...visible].reverse());
    $('#fromSelect').innerHTML = html;
    $('#toSelect').innerHTML = html;

    const stables = visible.filter(v => v.kind === 'stable');
    if (stables.length >= 2) {
        const newest = stables[stables.length - 1];
        const prev = stables[stables.length - 2];
        app.fromSha = prev.sha;
        app.toSha = newest.sha;
        $('#fromSelect').value = prev.sha;
        $('#toSelect').value = newest.sha;
    }
}

async function runDiff() {
    if (!app.fromSha || !app.toSha) return;
    if (app.fromSha === app.toSha) {
        $('#mainContent').innerHTML = `<div class="loader-full" style="padding:60px"><div style="color:var(--text-muted)">Choose two different versions to compare.</div></div>`;
        $('#summary').style.display = 'none';
        $('#filters').style.display = 'none';
        return;
    }

    const fromV = app.versions.find(v => v.sha === app.fromSha);
    const toV = app.versions.find(v => v.sha === app.toSha);
    if (!fromV || !toV) return;

    // Determine chronological ordering — ensure we load the older one as "before"
    const [olderV, newerV] = fromV.date <= toV.date ? [fromV, toV] : [toV, fromV];

    setStatus('loading', app.viaChain ? 'loading chain…' : 'loading readmes…');

    // For chain mode, collect all versions between (and including) olderV and newerV
    let intermediates = [olderV, newerV];
    if (app.viaChain) {
        // Include stable + pre-releases depending on the includePre setting, but ALWAYS
        // stick with what's in the dropdowns (the same visibility filter)
        const kinds = app.includePre ? ['stable', 'prerelease', 'snapshot'] : ['stable'];
        intermediates = app.versions.filter(v =>
            kinds.includes(v.kind) && v.date >= olderV.date && v.date <= newerV.date
        );
        // Safety: only cap at truly excessive lengths (readmes are fetched via raw.githubusercontent.com, not API)
        if (intermediates.length > 100) {
            $('#mainContent').innerHTML = `<div class="error-banner"><strong>Chain too long:</strong> ${intermediates.length} intermediate versions. Try narrowing the range.</div>`;
            setStatus('error', 'chain too long');
            return;
        }
    }

    $('#mainContent').innerHTML = `<div class="loader-full">
    <div class="spinner"></div>
    <div>Diffing <strong>${esc(olderV.version)}</strong> → <strong>${esc(newerV.version)}</strong>${app.viaChain ? ` <span style="color:var(--accent-fg)">via ${intermediates.length - 2} intermediate version${intermediates.length - 2 === 1 ? '' : 's'}</span>` : ''}</div>
    <div class="sub">fetching ${intermediates.length} readme file${intermediates.length === 1 ? '' : 's'}</div>
  </div>`;

    try {
        let diff;
        if (app.viaChain && intermediates.length > 2) {
            diff = await diffProtocolChain(olderV, newerV, intermediates);
        } else {
            const [before, after] = await Promise.all([loadVersionData(olderV), loadVersionData(newerV)]);
            diff = diffProtocol(before, after);
        }
        app.currentDiff = diff;
        app.currentVersions = {from: olderV, to: newerV, intermediates};
        renderDiff(olderV, newerV, diff);
        const statusLabel = app.viaChain && intermediates.length > 2
            ? `${olderV.version} → ${newerV.version} (chain, ${intermediates.length - 1} steps)`
            : `${olderV.version} → ${newerV.version}`;
        setStatus('ok', statusLabel);
        updateUrl(true); // replaceState to normalize URL after resolve
    } catch (e) {
        console.error(e);
        $('#mainContent').innerHTML = `<div class="error-banner"><strong>Error:</strong> ${esc(e.message)}</div>`;
        setStatus('error', 'failed');
    }
}

function renderDiff(fromV, toV, diff) {
    $('#summary').style.display = 'flex';
    $('#filters').style.display = 'flex';

    $('#cntAdded').textContent = diff.totals.added;
    $('#cntRemoved').textContent = diff.totals.removed;
    $('#cntModified').textContent = diff.totals.modified;
    $('#cntRenamed').textContent = diff.totals.renamed;
    $('#cntRelocated').textContent = diff.totals.relocated;

    const pb = diff.before.protocol, pa = diff.after.protocol;
    $('#protoRange').textContent = pb && pa ? (pb === pa ? pb : `${pb} → ${pa}`) : '?';
    const days = Math.round((toV.date - fromV.date) / (1000 * 60 * 60 * 24));
    $('#daysRange').innerHTML = `<strong>${Math.abs(days)}</strong> days apart`;
    $('#unchangedCount').innerHTML = `<strong>${diff.totals.unchanged}</strong> unchanged`;

    // Summary text
    generateSummaryText(diff);

    const cb = diff.groups.filter(g => (g.direction || '').toLowerCase() === 'clientbound');
    const sb = diff.groups.filter(g => (g.direction || '').toLowerCase() === 'serverbound');

    $('#mainContent').innerHTML = `
    <div class="columns">
      <div class="col">
        <div class="col-header cb">
          <span class="arrow-big">S → C</span>
          <span class="title">Clientbound</span>
          <span class="count" id="cbCount">—</span>
        </div>
        <div class="col-body" id="cbBody">${renderColumn(cb)}</div>
      </div>
      <div class="col">
        <div class="col-header sb">
          <span class="arrow-big">C → S</span>
          <span class="title">Serverbound</span>
          <span class="count" id="sbCount">—</span>
        </div>
        <div class="col-body" id="sbBody">${renderColumn(sb)}</div>
      </div>
    </div>
  `;
    bindPacketClicks();
    bindCollapsibleGroups();
    applyFilters();
}

/* ——— Summary text generator ——— */
function generateSummaryText(diff) {
    const el = $('#summaryText');
    const t = diff.totals;
    const total = t.added + t.removed + t.modified + t.renamed + t.relocated;
    if (total === 0) {
        el.style.display = 'none';
        return;
    }

    const parts = [];

    // Relocated summary
    if (t.relocated > 0) {
        parts.push(`<span class="hi-rel">${t.relocated} packet${t.relocated === 1 ? '' : 's'} relocated</span><span>(ID shift only, no structural changes)</span>`);
    }

    // Modified summary — analyze the most common field-level change patterns
    if (t.modified > 0) {
        const patterns = analyzeModificationPatterns(diff);
        let modPart = `<span class="hi-mod">${t.modified} modified</span>`;
        if (patterns.length) {
            modPart += `<span>— ${patterns.join(', ')}</span>`;
        }
        parts.push(modPart);
    }

    // Added
    if (t.added > 0) {
        const addedNames = collectNames(diff, 'added');
        const nameStr = addedNames.length <= 4
            ? addedNames.map(n => `<code>${esc(n)}</code>`).join(', ')
            : addedNames.slice(0, 3).map(n => `<code>${esc(n)}</code>`).join(', ') + ` + ${addedNames.length - 3} more`;
        parts.push(`<span class="hi-add">${t.added} new</span><span>(${nameStr})</span>`);
    }

    // Removed
    if (t.removed > 0) {
        const removedNames = collectNames(diff, 'removed');
        const nameStr = removedNames.length <= 3
            ? removedNames.map(n => `<code>${esc(n)}</code>`).join(', ')
            : removedNames.slice(0, 2).map(n => `<code>${esc(n)}</code>`).join(', ') + ` + ${removedNames.length - 2} more`;
        parts.push(`<span class="hi-rem">${t.removed} removed</span><span>(${nameStr})</span>`);
    }

    // Renamed
    if (t.renamed > 0) {
        parts.push(`<span class="hi-ren">${t.renamed} renamed</span><span>(cosmetic, no wire-protocol impact)</span>`);
    }

    // Section renames
    const sectionRenames = diff.groups.filter(g => g.oldStateName).map(g => `${g.oldStateName} → ${g.stateName}`);
    if (sectionRenames.length) {
        parts.push(`<span class="hi">section rename${sectionRenames.length === 1 ? '' : 's'}:</span><span>${sectionRenames.map(s => `<code>${esc(s)}</code>`).join(', ')}</span>`);
    }

    el.innerHTML = parts.join('<span style="color:var(--border);margin:0 6px">·</span>');
    el.style.display = parts.length ? 'block' : 'none';
}

function analyzeModificationPatterns(diff) {
    const typeChanges = new Map(); // "X → Y" pattern frequency
    let fieldAdds = 0, fieldRemoves = 0, fieldReorders = 0;

    for (const g of diff.groups) {
        for (const p of g.packets) {
            if (p.tag !== 'modified' || !p.fieldDiff) continue;
            for (const r of p.fieldDiff.rows) {
                if (r.state === 'changed') {
                    // Extract the "wrapping" pattern: e.g. MobEffect → Holder<MobEffect> = "Holder wrapping"
                    const before = r.before.full, after = r.after.full;
                    if (after.startsWith('Holder<') && after.includes(before.replace(/</g, ''))) {
                        typeChanges.set('Holder<> wrapping', (typeChanges.get('Holder<> wrapping') || 0) + 1);
                    } else if (after.startsWith('Optional<') && after.includes(before)) {
                        typeChanges.set('Optional<> wrapping', (typeChanges.get('Optional<> wrapping') || 0) + 1);
                    } else {
                        typeChanges.set('type changes', (typeChanges.get('type changes') || 0) + 1);
                    }
                } else if (r.state === 'added') fieldAdds++;
                else if (r.state === 'removed') fieldRemoves++;
            }
            if (p.fieldDiff.reorderedFields && p.fieldDiff.reorderedFields.length) fieldReorders++;
        }
    }

    const patterns = [];
    for (const [pattern, count] of [...typeChanges.entries()].sort((a, b) => b[1] - a[1])) {
        patterns.push(`${count}× ${pattern}`);
    }
    if (fieldAdds) patterns.push(`${fieldAdds} field${fieldAdds === 1 ? '' : 's'} added`);
    if (fieldRemoves) patterns.push(`${fieldRemoves} field${fieldRemoves === 1 ? '' : 's'} removed`);
    if (fieldReorders) patterns.push(`${fieldReorders} reordered`);

    return patterns;
}

function collectNames(diff, tag) {
    const names = [];
    for (const g of diff.groups) {
        for (const p of g.packets) {
            if (p.tag === tag) names.push((p.after || p.before).name);
        }
    }
    return names;
}

function renderColumn(groups) {
    if (!groups.length) return `<div class="empty-col">No changes in this direction</div>`;
    const rendered = groups.map(renderStateGroup).filter(Boolean).join('');
    return rendered || `<div class="empty-col">No changes in this direction</div>`;
}

function renderStateGroup(g) {
    const packets = g.packets.filter(p => p.tag !== 'unchanged');
    if (!packets.length) return '';
    const name = g.oldStateName
        ? `${esc(g.oldStateName)} <span class="name-change">→ ${esc(g.stateName)}</span>`
        : esc(g.stateName);
    return `<div class="state-group" data-state="${esc(g.stateName.toLowerCase())}">
    <div class="state-group-head"><span class="chevron">▼</span><span>${name}</span><span style="margin-left:auto">${packets.length} changed</span></div>
    <div class="state-group-body">${packets.map(p => renderPacket(p, g)).join('')}</div>
  </div>`;
}

function renderPacket(p, group) {
    const ref = p.after || p.before;
    let idHtml;
    if (p.idChanged) {
        idHtml = `<span class="pkt-id id-change"><span class="old">${p.before.idHex}</span><span class="arr">→</span><span class="new">${p.after.idHex}</span></span>`;
    } else {
        idHtml = `<span class="pkt-id">${ref.idHex}</span>`;
    }

    let nameHtml;
    if (p.nameChanged && p.before && p.after) {
        nameHtml = `<span class="pkt-name"><span class="old-name">${esc(p.before.name)}</span><span class="arr">→</span>${esc(p.after.name)}</span>`;
    } else {
        nameHtml = `<span class="pkt-name">${esc(ref.name)}</span>`;
    }

    const preview = renderPreview(p);

    const searchBits = [
        (p.after || p.before).name,
        (p.before || p.after).name,
        ...((p.after && p.after.fields) || []).map(f => `${f.name} ${f.full}`),
        ...((p.before && p.before.fields) || []).map(f => `${f.name} ${f.full}`),
    ];

    // Stable UID = direction + current ID + normalized name. Used for URL expand state.
    const dir = (ref.dir || '').toLowerCase().replace(/\s+/g, '');
    const uidName = ref.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const pktUid = `${dir}-${ref.idHex}-${uidName}`;

    const chainBadge = p.chain && p.chain.length
        ? p.chain.length === 1
            ? `<span class="chain-badge">⛓ in ${esc(p.chain[0].to.version)}</span>`
            : `<span class="chain-badge">⛓ ${p.chain.length} steps</span>`
        : '';

    // PacketEvents wrapper lookup
    let wrapperBadge = '';
    if (group && app.currentVersions) {
        const toVersion = app.currentVersions.to.version;
        const direction = (group.direction || '').toLowerCase();
        const stateName = group.stateName;
        const lookupRef = p.after || p.before;
        const wi = lookupWrapper(lookupRef.id, toVersion, direction, stateName);
        if (wi) {
            // Check if PE version is an exact match or a close fallback
            const mcNorm = toVersion.replace(/-(?:pre|rc|snapshot).*$/i, '').replace(/\./g, '_');
            const isExact = wi.peVersion === mcNorm;

            if (wi.wrapper) {
                const cls = isExact ? 'wrapper-badge' : 'wrapper-badge wrapper-approx';
                const title = isExact
                    ? `${wi.enumName} — PacketEvents ${wi.peVersion.replace(/_/g, '.')}`
                    : `${wi.enumName} — mapped from PE ${wi.peVersion.replace(/_/g, '.')} (no exact match for ${toVersion})`;
                wrapperBadge = wi.url
                    ? `<a class="${cls}" href="${esc(wi.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(title)}">${esc(wi.wrapper)}</a>`
                    : `<span class="${cls}" title="${esc(title)}">${esc(wi.wrapper)}</span>`;
            } else {
                wrapperBadge = `<span class="wrapper-badge no-wrapper" title="${esc(wi.enumName)} — no wrapper class">${esc(wi.enumName)}</span>`;
            }
        }
    }

    return `<div class="pkt ${p.tag}" data-tag="${p.tag}" data-pkt-uid="${esc(pktUid)}" data-search="${esc(searchBits.join(' ').toLowerCase())}">
    <div class="pkt-row">
      ${idHtml}
      ${nameHtml}
      <span class="pkt-tags">
        ${wrapperBadge}
        <span class="pkt-tag ${p.tag}">${p.tag}</span>
        ${p.idChanged && p.tag !== 'relocated' ? '<span class="pkt-tag relocated">id</span>' : ''}
        ${chainBadge}
      </span>
    </div>
    ${preview}
    <div class="pkt-details">${renderDetails(p)}</div>
  </div>`;
}

function renderPreview(p) {
    if (p.tag === 'added' && p.after) {
        const n = p.after.fields.length;
        return `<div class="pkt-preview"><span class="pv-item add-dot">+ new packet</span><span class="pv-item">${p.after.noFields ? 'no fields' : n + ' field' + (n === 1 ? '' : 's')}</span></div>`;
    }
    if (p.tag === 'removed' && p.before) {
        const n = p.before.fields.length;
        return `<div class="pkt-preview"><span class="pv-item rem-dot">− removed</span><span class="pv-item">had ${p.before.noFields ? 'no fields' : n + ' field' + (n === 1 ? '' : 's')}</span></div>`;
    }
    if (p.fieldDiff) {
        const added = p.fieldDiff.rows.filter(r => r.state === 'added').length;
        const removed = p.fieldDiff.rows.filter(r => r.state === 'removed').length;
        const changed = p.fieldDiff.rows.filter(r => r.state === 'changed').length;
        const reordered = (p.fieldDiff.reorderedFields || []).length;
        const parts = [];
        if (added) parts.push(`<span class="pv-item add-dot">+${added} field${added === 1 ? '' : 's'}</span>`);
        if (removed) parts.push(`<span class="pv-item rem-dot">−${removed} field${removed === 1 ? '' : 's'}</span>`);
        if (changed) parts.push(`<span class="pv-item chg-dot">${changed} type${changed === 1 ? '' : 's'} changed</span>`);
        if (reordered) parts.push(`<span class="pv-item reorder-dot">⇵ ${reordered} reordered</span>`);
        if (p.idChanged) parts.push(`<span class="pv-item">id ${p.before.idHex}→${p.after.idHex}</span>`);
        if (p.dirChanged) parts.push(`<span class="pv-item">dir ${p.before.dir || '—'}→${p.after.dir || '—'}</span>`);
        if (!parts.length) return '';
        return `<div class="pkt-preview">${parts.join('')}</div>`;
    }
    return '';
}

function renderDetails(p) {
    const meta = [];
    if (p.idChanged) meta.push(`id: <span class="old">${p.before.idHex}</span> → <span class="new">${p.after.idHex}</span>`);
    if (p.nameChanged) meta.push(`name: <span class="old">${esc(p.before.name)}</span> → <span class="new">${esc(p.after.name)}</span>`);
    if (p.dirChanged) meta.push(`direction: <span class="old">${esc(p.before.dir || '—')}</span> → <span class="new">${esc(p.after.dir || '—')}</span>`);
    if (p.fieldDiff && p.fieldDiff.reorderedFields && p.fieldDiff.reorderedFields.length) {
        const names = p.fieldDiff.reorderedFields.map(r => esc(r.name)).join(', ');
        meta.push(`reordered: <span style="color:var(--renamed)">${names}</span>`);
    }
    const metaHtml = meta.length ? `<div class="meta-change">${meta.join(' · ')}</div>` : '';

    // View toggle: structured vs raw markdown
    const viewToggle = `<div class="pkt-view-toggle">
    <button class="active" data-view="structured">structured</button>
    <button data-view="raw">raw markdown</button>
  </div>`;

    let tableHtml;
    if (p.tag === 'added') tableHtml = renderFieldTableFlat(p.after.fields, 'added', p.after.noFields);
    else if (p.tag === 'removed') tableHtml = renderFieldTableFlat(p.before.fields, 'removed', p.before.noFields);
    else if (p.fieldDiff) tableHtml = renderFieldTableDiff(p.fieldDiff.rows);
    else tableHtml = '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">(no field changes)</em>';

    // Chain steps if present
    const chainHtml = (p.chain && p.chain.length) ? renderChainSteps(p) : '';

    return metaHtml + viewToggle + `<div class="pkt-view-structured">${tableHtml}${chainHtml}</div><div class="pkt-view-raw" style="display:none"><em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">click to load raw markdown…</em></div>`;
}

function renderChainSteps(p) {
    if (!p.chain.length) return '';
    const label = p.chain.length === 1
        ? `changed in <strong style="color:var(--text)">${esc(p.chain[0].from.version)} → ${esc(p.chain[0].to.version)}</strong>`
        : `evolution over ${p.chain.length} steps`;
    let html = `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border)">
    <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px">${label}</div>`;
    for (const step of p.chain) {
        html += renderChainStep(step);
    }
    html += `</div>`;
    return html;
}

function renderChainStep(step) {
    const sp = step.packet;
    const ref = sp.after || sp.before;
    const changes = [];

    if (sp.idChanged) changes.push(`<span class="change meta">id: ${sp.before.idHex} → ${sp.after.idHex}</span>`);
    if (sp.nameChanged) changes.push(`<span class="change meta">name: ${esc(sp.before.name)} → ${esc(sp.after.name)}</span>`);
    if (sp.dirChanged) changes.push(`<span class="change meta">direction: ${esc(sp.before.dir || '—')} → ${esc(sp.after.dir || '—')}</span>`);

    if (sp.tag === 'added') {
        changes.push(`<span class="change add">+ added as new packet</span>`);
    } else if (sp.tag === 'removed') {
        changes.push(`<span class="change rem">− removed</span>`);
    } else if (sp.fieldDiff) {
        for (const r of sp.fieldDiff.rows) {
            if (r.state === 'added') changes.push(`<span class="change add">+ ${esc(r.after.name)}: ${esc(r.after.full)}</span>`);
            else if (r.state === 'removed') changes.push(`<span class="change rem">− ${esc(r.before.name)}: ${esc(r.before.full)}</span>`);
            else if (r.state === 'changed') changes.push(`<span class="change chg">~ ${esc(r.after.name)}: ${esc(r.before.full)} → ${esc(r.after.full)}</span>`);
        }
        if (sp.fieldDiff.reorderedFields && sp.fieldDiff.reorderedFields.length) {
            changes.push(`<span class="change chg">⇵ reordered: ${sp.fieldDiff.reorderedFields.map(r => esc(r.name)).join(', ')}</span>`);
        }
    }

    return `<div class="chain-step chain-${sp.tag}">
    <div class="chain-step-head">
      <span class="step-ver">${esc(step.from.version)}</span>
      <span class="step-arrow">→</span>
      <span class="step-ver">${esc(step.to.version)}</span>
      <span class="pkt-tag ${sp.tag}">${sp.tag}</span>
    </div>
    <div class="chain-step-body">${changes.join('')}</div>
  </div>`;
}

function renderFieldTableFlat(fields, kind, noFields) {
    if (noFields) return '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">Packet has no fields</em>';
    if (!fields.length) return '';
    const sign = kind === 'added' ? '+' : kind === 'removed' ? '−' : '';
    const rowClass = kind === 'added' ? 'ft-added' : kind === 'removed' ? 'ft-removed' : '';
    return `<div class="field-table">
    <div class="ft-head"><span style="text-align:right">#</span><span></span><span>name</span><span>type</span></div>
    ${fields.map(f => `<div class="ft-row ${rowClass}">
      <span class="idx">${esc(f.idx)}</span>
      <span class="sign">${sign}</span>
      <span class="name">${esc(f.name)}</span>
      <span class="type">${esc(f.full)}</span>
    </div>`).join('')}
  </div>`;
}

function renderFieldTableDiff(rows) {
    if (!rows.length) return '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">no fields</em>';
    return `<div class="field-table">
    <div class="ft-head"><span style="text-align:right">#</span><span></span><span>name</span><span>type</span></div>
    ${rows.map(r => {
        if (r.state === 'added') return `<div class="ft-row ft-added">
        <span class="idx">${esc(r.after.idx)}</span><span class="sign">+</span>
        <span class="name">${esc(r.after.name)}</span><span class="type">${esc(r.after.full)}</span></div>`;
        if (r.state === 'removed') return `<div class="ft-row ft-removed">
        <span class="idx">${esc(r.before.idx)}</span><span class="sign">−</span>
        <span class="name">${esc(r.before.name)}</span><span class="type">${esc(r.before.full)}</span></div>`;
        if (r.state === 'changed') return `<div class="ft-row ft-changed">
        <span class="idx">${esc(r.after.idx)}</span><span class="sign">~</span>
        <span class="name">${esc(r.after.name)}</span>
        <span class="type"><span class="type-before">${esc(r.before.full)}</span><span class="type-after">${esc(r.after.full)}</span></span></div>`;
        return `<div class="ft-row">
        <span class="idx">${esc(r.after.idx)}</span><span class="sign" style="color:var(--text-subtle)">·</span>
        <span class="name">${esc(r.after.name)}</span><span class="type">${esc(r.after.full)}</span></div>`;
    }).join('')}
  </div>`;
}

function bindPacketClicks() {
    $$('.pkt').forEach(el => {
        el.addEventListener('click', async (ev) => {
            // Don't toggle expand when clicking interactive children
            if (ev.target.closest('.pkt-view-toggle, .pkt-view-raw, .pkt-view-structured button, a')) return;
            // If click originated inside the expanded details but not on the pkt-row, don't collapse
            const row = ev.target.closest('.pkt-row, .pkt-preview');
            if (!row && el.classList.contains('expanded')) return;
            el.classList.toggle('expanded');
        });
    });

    // Wire up per-packet view toggles (structured/raw)
    $$('.pkt-view-toggle').forEach(toggle => {
        toggle.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('button');
            if (!btn) return;
            ev.stopPropagation();
            const mode = btn.dataset.view;
            const pkt = toggle.closest('.pkt');
            toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
            const structured = pkt.querySelector('.pkt-view-structured');
            const raw = pkt.querySelector('.pkt-view-raw');
            if (mode === 'raw') {
                structured.style.display = 'none';
                raw.style.display = '';
                // Lazy-load raw markdown on first request
                if (raw.dataset.loaded !== '1') {
                    await loadRawIntoPacket(pkt, raw);
                }
            } else {
                structured.style.display = '';
                raw.style.display = 'none';
            }
        });
    });
}

async function loadRawIntoPacket(pktEl, rawEl) {
    const uid = pktEl.dataset.pktUid;
    // Find the packet in currentDiff to know which section/direction/name to extract
    if (!app.currentDiff || !app.currentVersions) {
        rawEl.innerHTML = '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">no diff loaded</em>';
        return;
    }
    // Find packet by uid walking all groups
    let targetPkt = null, targetGroup = null;
    for (const g of app.currentDiff.groups) {
        for (const p of g.packets) {
            const ref = p.after || p.before;
            const dir = (ref.dir || '').toLowerCase().replace(/\s+/g, '');
            const uidName = ref.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (`${dir}-${ref.idHex}-${uidName}` === uid) {
                targetPkt = p;
                targetGroup = g;
                break;
            }
        }
        if (targetPkt) break;
    }
    if (!targetPkt) {
        rawEl.innerHTML = '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">packet not found</em>';
        rawEl.dataset.loaded = '1';
        return;
    }

    rawEl.innerHTML = '<em style="color:var(--text-subtle);font-family:var(--mono);font-size:11px">loading…</em>';
    const {from, to} = app.currentVersions;

    // Fetch raw markdown blocks for both versions. Use the most-informative name from each side.
    const beforeName = targetPkt.before ? targetPkt.before.name : null;
    const afterName = targetPkt.after ? targetPkt.after.name : null;
    const beforeStateName = targetGroup.oldStateName || targetGroup.stateName;
    const afterStateName = targetGroup.stateName;

    const [beforeRaw, afterRaw] = await Promise.all([
        beforeName ? getRawPacketMarkdown(from, targetGroup.direction, beforeName) : null,
        afterName ? getRawPacketMarkdown(to, targetGroup.direction, afterName) : null,
    ]);

    rawEl.innerHTML = `
    <div class="raw-view">
      <div class="raw-col">
        <div class="raw-col-head before">before<span class="ver">${esc(from.version)}</span></div>
        <pre>${beforeRaw ? esc(beforeRaw.markdown) : '<em>not present in this version</em>'}</pre>
      </div>
      <div class="raw-col">
        <div class="raw-col-head after">after<span class="ver">${esc(to.version)}</span></div>
        <pre>${afterRaw ? esc(afterRaw.markdown) : '<em>not present in this version</em>'}</pre>
      </div>
    </div>
  `;
    rawEl.dataset.loaded = '1';
}

/* ——— Collapsible state groups ——— */
function bindCollapsibleGroups() {
    $$('.state-group-head').forEach(head => {
        head.addEventListener('click', (e) => {
            // Don't collapse when clicking inside the group body
            const group = head.closest('.state-group');
            group.classList.toggle('collapsed');
        });
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILTERING
   ═══════════════════════════════════════════════════════════════════════════ */
function applyFilters() {
    const q = app.filter.search;
    const tag = app.filter.tag;
    const state = app.filter.state;
    const breakingOnly = app.filter.breaking;
    const breakingTags = new Set(['removed', 'modified', 'added']);

    let cbVisible = 0, sbVisible = 0;

    $$('.state-group').forEach(group => {
        const groupState = group.dataset.state;
        let groupVisible = 0;
        group.querySelectorAll('.pkt').forEach(pkt => {
            const pktTag = pkt.dataset.tag;
            const searchBlob = pkt.dataset.search;
            let show = true;
            if (tag !== 'all' && pktTag !== tag) show = false;
            if (state !== 'all') {
                const matches = groupState === state
                    || (state === 'play' && (groupState === 'play' || groupState === 'game'))
                    || (state === 'handshake' && (groupState === 'handshake' || groupState === 'handshaking'))
                    || (state === 'configuration' && (groupState === 'configuration' || groupState === 'config'));
                if (!matches) show = false;
            }
            if (breakingOnly && !breakingTags.has(pktTag)) show = false;
            if (q && !searchBlob.includes(q)) show = false;
            pkt.style.display = show ? '' : 'none';
            if (show) groupVisible++;
        });
        group.style.display = groupVisible > 0 ? '' : 'none';
        if (groupVisible > 0) {
            const col = group.closest('.col');
            if (col && col.querySelector('.col-header.cb')) cbVisible += groupVisible;
            else sbVisible += groupVisible;
        }
    });

    const cbEl = $('#cbCount');
    if (cbEl) cbEl.textContent = cbVisible;
    const sbEl = $('#sbCount');
    if (sbEl) sbEl.textContent = sbVisible;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVENTS
   ═══════════════════════════════════════════════════════════════════════════ */
$('#fromSelect').addEventListener('change', e => {
    app.fromSha = e.target.value;
    runDiff();
});
$('#toSelect').addEventListener('change', e => {
    app.toSha = e.target.value;
    runDiff();
});

$('#includePreToggle').addEventListener('click', e => {
    e.preventDefault();
    const t = e.currentTarget;
    app.includePre = !app.includePre;
    t.classList.toggle('on', app.includePre);
    t.querySelector('input').checked = app.includePre;
    populateVersionPickers();
    runDiff();
});

$('#breakingToggle').addEventListener('click', e => {
    e.preventDefault();
    const t = e.currentTarget;
    app.filter.breaking = !app.filter.breaking;
    t.classList.toggle('on', app.filter.breaking);
    t.querySelector('input').checked = app.filter.breaking;
    applyFilters();
    updateUrl();
});

$('#viaChainToggle').addEventListener('click', e => {
    e.preventDefault();
    const t = e.currentTarget;
    app.viaChain = !app.viaChain;
    t.classList.toggle('on', app.viaChain);
    t.querySelector('input').checked = app.viaChain;
    runDiff();
});

$('#searchBox').addEventListener('input', e => {
    app.filter.search = e.target.value.trim().toLowerCase();
    applyFilters();
    updateUrl();
});

$$('#stateFilter button').forEach(b => {
    b.addEventListener('click', () => {
        $$('#stateFilter button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        app.filter.state = b.dataset.state;
        applyFilters();
        updateUrl();
    });
});

$$('.sum-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (app.filter.tag === tag) {
            app.filter.tag = 'all';
            chip.classList.remove('active');
        } else {
            app.filter.tag = tag;
            $$('.sum-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        }
        applyFilters();
        updateUrl();
    });
});

/* —— Expand / Collapse all —— */
function expandAll() {
    $$('.pkt').forEach(p => {
        if (p.style.display !== 'none') p.classList.add('expanded');
    });
}

function collapseAll() {
    $$('.pkt.expanded').forEach(p => p.classList.remove('expanded'));
}

$('#expandAllBtn').addEventListener('click', expandAll);
$('#collapseAllBtn').addEventListener('click', collapseAll);

/* —— Export menu —— */
$('#exportBtn').addEventListener('click', e => {
    e.stopPropagation();
    $('#exportMenu').classList.toggle('open');
});
document.addEventListener('click', e => {
    if (!e.target.closest('.export-wrap')) $('#exportMenu').classList.remove('open');
});
$$('#exportMenu button').forEach(btn => {
    btn.addEventListener('click', () => {
        exportDiffAsJson(btn.dataset.export);
        $('#exportMenu').classList.remove('open');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
   KEYBOARD NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */
function visiblePackets() {
    return [...$$('.pkt')].filter(p => p.style.display !== 'none');
}

function focusPkt(el, opts = {scroll: true}) {
    $$('.pkt.focused').forEach(p => p.classList.remove('focused'));
    if (!el) {
        app.focusedPktEl = null;
        return;
    }
    el.classList.add('focused');
    app.focusedPktEl = el;
    if (opts.scroll) {
        const rect = el.getBoundingClientRect();
        // Scroll if the focused packet is outside the visible viewport with some margin
        const topMargin = 180, bottomMargin = window.innerHeight - 60;
        if (rect.top < topMargin || rect.bottom > bottomMargin) {
            el.scrollIntoView({block: 'center', behavior: 'smooth'});
        }
    }
}

function moveFocus(delta) {
    const vis = visiblePackets();
    if (!vis.length) return;
    if (!app.focusedPktEl || !vis.includes(app.focusedPktEl)) {
        focusPkt(delta > 0 ? vis[0] : vis[vis.length - 1]);
        return;
    }
    const idx = vis.indexOf(app.focusedPktEl);
    const next = Math.max(0, Math.min(vis.length - 1, idx + delta));
    focusPkt(vis[next]);
}

document.addEventListener('keydown', e => {
    const tgt = e.target;
    const isInput = tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA';
    if (isInput) {
        if (e.key === 'Escape') {
            tgt.blur();
        }
        return;
    }
    // Ignore modifier combos we don't handle (except Shift for E/C)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '/') {
        e.preventDefault();
        $('#searchBox').focus();
    } else if (e.key === 'Escape') {
        if (app.focusedPktEl && app.focusedPktEl.classList.contains('expanded')) {
            app.focusedPktEl.classList.remove('expanded');
        } else if (document.querySelector('.pkt.expanded')) {
            collapseAll();
        } else {
            focusPkt(null);
        }
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveFocus(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(-1);
    } else if (e.key === 'g') {
        e.preventDefault();
        const vis = visiblePackets();
        if (vis.length) focusPkt(vis[0]);
    } else if (e.key === 'G') {
        e.preventDefault();
        const vis = visiblePackets();
        if (vis.length) focusPkt(vis[vis.length - 1]);
    } else if (e.key === 'Enter' || e.key === ' ') {
        if (app.focusedPktEl) {
            e.preventDefault();
            app.focusedPktEl.classList.toggle('expanded');
        }
    } else if (e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        expandAll();
    } else if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        collapseAll();
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POPSTATE — browser back/forward restores state without a full reload
   ═══════════════════════════════════════════════════════════════════════════ */
window.addEventListener('popstate', async () => {
    await applyStateFromUrl({reloadIfVersionsChanged: true});
});

async function applyStateFromUrl({reloadIfVersionsChanged = false} = {}) {
    const url = readUrl();

    // Toggle states
    const wantPre = url.pre;
    const wantChain = url.chain;
    const preChanged = wantPre !== app.includePre;
    const chainChanged = wantChain !== app.viaChain;

    if (preChanged) {
        app.includePre = wantPre;
        $('#includePreToggle').classList.toggle('on', wantPre);
        $('#includePreToggle input').checked = wantPre;
        populateVersionPickers();
    }
    if (chainChanged) {
        app.viaChain = wantChain;
        $('#viaChainToggle').classList.toggle('on', wantChain);
        $('#viaChainToggle input').checked = wantChain;
    }
    app.filter.breaking = url.breaking;
    $('#breakingToggle').classList.toggle('on', url.breaking);
    $('#breakingToggle input').checked = url.breaking;
    app.filter.tag = url.tag;
    app.filter.state = url.state;
    app.filter.search = url.q;

    $('#searchBox').value = url.q;
    $$('#stateFilter button').forEach(b => b.classList.toggle('active', b.dataset.state === url.state));
    $$('.sum-chip').forEach(c => c.classList.toggle('active', c.dataset.tag === url.tag));

    // Versions
    const fromSha = resolveShaByPrefix(url.fromPrefix);
    const toSha = resolveShaByPrefix(url.toPrefix);
    const versionChanged = (fromSha && fromSha !== app.fromSha) || (toSha && toSha !== app.toSha);
    if (fromSha) {
        app.fromSha = fromSha;
        $('#fromSelect').value = fromSha;
    }
    if (toSha) {
        app.toSha = toSha;
        $('#toSelect').value = toSha;
    }

    app.suppressUrlUpdate = true;
    try {
        if (reloadIfVersionsChanged && (versionChanged || preChanged || chainChanged)) {
            await runDiff();
        } else {
            applyFilters();
        }
    } finally {
        app.suppressUrlUpdate = false;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
async function init() {
    try {
        app.versions = await loadVersionIndex();
        app.packetEvents = await loadPacketEventsData();
        if (app.versions.length < 2) {
            $('#mainContent').innerHTML = `<div class="error-banner">Not enough protocol versions found. Run the sync script first.</div>`;
            setStatus('error', 'no data');
            return;
        }

        // Read URL state BEFORE populating pickers (so includePre is set correctly)
        const url = readUrl();
        if (url.pre) {
            app.includePre = true;
            $('#includePreToggle').classList.add('on');
            $('#includePreToggle input').checked = true;
        }
        if (url.chain) {
            app.viaChain = true;
            $('#viaChainToggle').classList.add('on');
            $('#viaChainToggle input').checked = true;
        }
        if (url.breaking) {
            app.filter.breaking = true;
            $('#breakingToggle').classList.add('on');
            $('#breakingToggle input').checked = true;
        }
        app.filter.tag = url.tag;
        app.filter.state = url.state;
        app.filter.search = url.q;
        $('#searchBox').value = url.q;
        $$('#stateFilter button').forEach(b => b.classList.toggle('active', b.dataset.state === url.state));
        $$('.sum-chip').forEach(c => c.classList.toggle('active', c.dataset.tag === url.tag));

        populateVersionPickers();

        // Override default versions if URL specified them
        const fromSha = resolveShaByPrefix(url.fromPrefix);
        const toSha = resolveShaByPrefix(url.toPrefix);
        if (fromSha) {
            app.fromSha = fromSha;
            $('#fromSelect').value = fromSha;
        }
        if (toSha) {
            app.toSha = toSha;
            $('#toSelect').value = toSha;
        }

        app.suppressUrlUpdate = true;
        try {
            await runDiff();
        } finally {
            app.suppressUrlUpdate = false;
        }
    } catch (e) {
        console.error(e);
        $('#mainContent').innerHTML = `<div class="error-banner"><strong>Failed to load:</strong> ${esc(e.message)}</div>`;
        setStatus('error', 'failed');
    }
}

init();