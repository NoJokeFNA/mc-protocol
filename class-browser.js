/* Exact-version Minecraft class lookup. No source code is redistributed here. */
(function (root) {
    'use strict';
    const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const CONTAINERS = new Set(['Optional', 'List', 'Set', 'Map', 'Collection', 'Holder',
        'Pair', 'EnumSet', 'String', 'UUID', 'IntList', 'Int2ObjectMap', 'Object2IntMap']);

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    }

    function renderType(type, version) {
        if (!version) return escapeHtml(type);
        // Preserve qualified and nested names; link every domain type in generics.
        const pattern = /\b(?:[a-z_$][\w$]*\.)*[A-Z][\w$]*(?:\.[A-Z][\w$]*)*/g;
        let html = '', end = 0;
        for (const match of String(type).matchAll(pattern)) {
            html += escapeHtml(type.slice(end, match.index));
            const name = match[0];
            html += CONTAINERS.has(name) ? escapeHtml(name)
                : `<button type="button" class="class-link" data-class="${escapeHtml(name)}" data-version="${escapeHtml(version)}" title="View ${escapeHtml(name)} in Minecraft ${escapeHtml(version)}">${escapeHtml(name)}</button>`;
            end = match.index + name.length;
        }
        return html + escapeHtml(type.slice(end));
    }

    function resolveVersion(requested, versions) {
        const name = requested.trim().replace(/^mc\s+/i, '');
        // Older mc-protocol data uses e.g. 1.19.1-pre-2; newer Mojang IDs
        // actually contain this extra dash. Always prefer the exact ID.
        const aliases = [name, name.replace(/-(pre|rc)-(\d+)$/, '-$1$2')];
        return aliases.map(id => versions.find(v => v.id === id)).find(Boolean) || null;
    }

    function findClasses(names, query) {
        const canonical = name => name.replace(/\$/g, '.');
        const wanted = canonical(query);
        const qualified = wanted.includes('.');
        return names.filter(name => {
            const full = canonical(name);
            return qualified ? full === wanted || (!query.startsWith('net.') && full.endsWith(`.${wanted}`))
                : full.split('.').pop() === wanted;
        }).sort();
    }

    function parseMappings(text) {
        return [...new Set([...text.matchAll(/^([^\s#][^\n]*?) -> [^\n]+:$/gm)]
            .map(m => m[1]).filter(name => name.startsWith('net.minecraft.')))];
    }

    function sourceUrl(name, version, side = 'client') {
        const host = side === 'server' ? 'mcsrv.dev' : 'mcsrc.dev';
        // mcsrc reads its class pathname literally, so keep Java's '$' nested
        // class separator unescaped (it is valid in a URL path).
        const path = name.split('.').map(part => encodeURIComponent(part).replace(/%24/g, '$')).join('/');
        return `https://${host}/2/${encodeURIComponent(version)}/${path}`;
    }

    // Read the central directory rather than guessing Java package names. The
    // complete official download is SHA-1 checked before its ZIP is inspected.
    function zipEntries(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let eocd = bytes.length - 22;
        for (; eocd >= Math.max(0, bytes.length - 65557); eocd--) {
            if (view.getUint32(eocd, true) === 0x06054b50 && eocd + 22 + view.getUint16(eocd + 20, true) === bytes.length) break;
        }
        if (eocd < Math.max(0, bytes.length - 65557)) throw new Error('Invalid Minecraft JAR (ZIP directory missing).');
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        if (count === 65535 || offset === 0xffffffff) throw new Error('ZIP64 JARs are not supported by this class index.');
        const entries = [];
        for (let i = 0; i < count; i++) {
            if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid Minecraft JAR directory.');
            const length = view.getUint16(offset + 28, true);
            entries.push({name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length)),
                method: view.getUint16(offset + 10, true), size: view.getUint32(offset + 20, true),
                offset: view.getUint32(offset + 42, true)});
            offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
        }
        return entries;
    }

    async function jarClasses(bytes) {
        const entries = zipEntries(bytes);
        const names = entries.filter(e => e.name.startsWith('net/minecraft/') && e.name.endsWith('.class'))
            .map(e => e.name.slice(0, -6).replace(/\//g, '.'));
        const inner = entries.find(e => /^META-INF\/versions\/[^/]+\/[^/]+\.jar$/.test(e.name));
        if (!inner) {
            if (names.length) return names;
            throw new Error('No readable Minecraft class names in this JAR.');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const start = inner.offset + 30 + view.getUint16(inner.offset + 26, true) + view.getUint16(inner.offset + 28, true);
        let data = bytes.subarray(start, start + inner.size);
        if (inner.method === 8) {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else if (inner.method !== 0) throw new Error('Unsupported server JAR compression.');
        return jarClasses(data);
    }

    function createResolver(fetcher = root.fetch.bind(root), crypto = root.crypto) {
        let manifest;
        const catalogs = new Map();
        async function response(url, signal) {
            const res = await fetcher(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(120000)].filter(Boolean))});
            if (!res.ok) throw new Error(`Minecraft download failed (HTTP ${res.status}). Please retry.`);
            return res;
        }
        async function artifact(info, signal) {
            const bytes = await (await response(info.url, signal)).arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-1', bytes);
            const sha1 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
            if (sha1 !== info.sha1) throw new Error('Minecraft download checksum mismatch. Please retry.');
            return new Uint8Array(bytes);
        }
        return {
            async lookup(query, requested, side = 'client', {signal, progress = () => {}} = {}) {
                if (!manifest) manifest = await (await response(MANIFEST, signal)).json();
                const version = resolveVersion(requested, manifest.versions);
                if (!version) throw new Error(`Minecraft ${requested} is not in the official version index. No other version was substituted.`);
                const key = `${version.id}:${side}`;
                let names = catalogs.get(key);
                if (!names) {
                    progress(`Loading class index for Minecraft ${version.id}…`);
                    const metadataBytes = await artifact(version, signal);
                    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
                    const mapping = metadata.downloads[`${side}_mappings`];
                    if (mapping) {
                        names = parseMappings(new TextDecoder().decode(await artifact(mapping, signal)));
                    } else {
                        // 26.1+ ships readable names, with no separate mappings.
                        // Do not treat an old obfuscated JAR as readable source.
                        if (new Date(version.releaseTime) < new Date('2025-12-16')) {
                            throw new Error(`Official ${side} mappings are unavailable for Minecraft ${version.id}.`);
                        }
                        const jar = metadata.downloads[side];
                        if (!jar) throw new Error(`No ${side} JAR is available for Minecraft ${version.id}.`);
                        progress(`Loading class names from the official ${side} JAR (${Math.ceil(jar.size / 1048576)} MB). This happens once per version while this page is open…`);
                        names = await jarClasses(await artifact(jar, signal));
                    }
                    catalogs.set(key, names);
                    // Keep only a few small name catalogs, never the JAR bytes.
                    if (catalogs.size > 6) catalogs.delete(catalogs.keys().next().value);
                }
                return {version: version.id, side, matches: findClasses(names, query)};
            },
        };
    }

    function install(document) {
        const resolver = createResolver();
        document.addEventListener('click', event => {
            const trigger = event.target.closest('.class-link');
            if (!trigger) return;
            event.stopPropagation();
            document.querySelector('.class-dialog')?.close();
            let controller;
            const dialog = document.createElement('dialog');
            dialog.className = 'class-dialog';
            dialog.setAttribute('aria-labelledby', 'class-dialog-title');
            dialog.innerHTML = `<header><div><h2 id="class-dialog-title"></h2><p class="class-version"></p></div><button type="button" class="class-close" aria-label="Close class browser">×</button></header>
                <div class="class-sides" role="group" aria-label="Minecraft JAR"><button type="button" data-side="client">Client / shared</button><button type="button" data-side="server">Server</button></div>
                <p class="class-status" role="status"></p><div class="class-results"></div>
                <p class="class-note">Full Java code, including method bodies, opens in FabricMC’s mcsrc browser. It decompiles the selected version on your device; the first visit asks you to accept the Minecraft EULA.</p>`;
            dialog.querySelector('h2').textContent = trigger.dataset.class;
            document.body.append(dialog);
            const close = () => dialog.close();
            dialog.querySelector('.class-close').addEventListener('click', close);
            dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
            dialog.addEventListener('close', () => {
                controller?.abort();
                dialog.remove();
                if (trigger.isConnected) trigger.focus();
            }, {once: true});
            dialog.showModal();
            async function search(side) {
                controller?.abort();
                const request = controller = new AbortController();
                const status = dialog.querySelector('.class-status');
                const results = dialog.querySelector('.class-results');
                results.replaceChildren();
                dialog.querySelector('.class-version').textContent = `Minecraft ${trigger.dataset.version} · ${side}`;
                dialog.querySelectorAll('[data-side]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.side === side)));
                status.textContent = 'Finding the exact Minecraft version…';
                try {
                    const result = await resolver.lookup(trigger.dataset.class, trigger.dataset.version, side, {
                        signal: request.signal,
                        progress: text => { if (!request.signal.aborted) status.textContent = text; },
                    });
                    if (request.signal.aborted) return;
                    dialog.querySelector('.class-version').textContent = `Minecraft ${result.version} · ${side}`;
                    status.textContent = result.matches.length ? `${result.matches.length} matching class${result.matches.length === 1 ? '' : 'es'}. Select a class to view its full contents.`
                        : 'No exact class name found in this JAR. Try the other side. No other Minecraft version was substituted.';
                    for (const name of result.matches) {
                        const link = document.createElement('a');
                        link.href = sourceUrl(name, result.version, side);
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.className = 'class-result';
                        link.textContent = `${name} ↗`;
                        results.append(link);
                    }
                } catch (error) {
                    if (request.signal.aborted) return;
                    status.textContent = error.message;
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.textContent = 'Retry';
                    retry.addEventListener('click', () => search(side));
                    results.append(retry);
                }
            }
            dialog.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => search(button.dataset.side)));
            search('client');
        });
    }

    const api = {renderType, resolveVersion, findClasses, parseMappings, sourceUrl, zipEntries, jarClasses, createResolver, install};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ClassBrowser = api;
})(globalThis);
