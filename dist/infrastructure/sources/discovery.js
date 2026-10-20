/**
 * 来源发现：显式地址 + 本地语料目录（可选注入 web 搜索通道）。
 *
 * 不做的事：不自动爬站、不绕过登录/付费墙、不在未授权时访问网络。
 * 所有候选都带 quality 先验与 reason，模型能看见「为什么推荐它」。
 */
import { readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { classifySource, isPaywalledOrLogin, normalizeLocation, sourceQuality, suffixOf } from "./metadata.js";
const DEFAULT_PATTERNS = [
    '.md', '.txt', '.rst', '.html', '.htm', '.pdf', '.docx', '.py', '.rs', '.kt',
    '.ts', '.java', '.json',
];
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.svn', '.hg', 'dist', 'build']);
export function scanLocal(dir, options = {}) {
    const limit = Math.min(Math.max(1, options.limit ?? 200), 2000);
    const keywords = (options.keywords ?? []).map((item) => item.toLowerCase()).filter(Boolean);
    const patterns = new Set(options.patterns ?? DEFAULT_PATTERNS);
    const out = [];
    const walk = (current, depth) => {
        if (out.length >= limit || depth > 12)
            return;
        let entries;
        try {
            entries = readdirSync(current);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= limit)
                return;
            if (entry.startsWith('.') || SKIP_DIRS.has(entry))
                continue;
            const full = join(current, entry);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(full, depth + 1);
                continue;
            }
            if (!stat.isFile())
                continue;
            const suffix = extname(entry).toLowerCase();
            if (!patterns.has(suffix))
                continue;
            if (keywords.length > 0 && !keywords.some((keyword) => entry.toLowerCase().includes(keyword)))
                continue;
            const described = sourceQuality(classifySource(full), full);
            out.push({
                location: full,
                title: entry,
                source_type: classifySource(full, { docType: suffix.slice(1) }),
                quality: described.quality,
                quality_basis: described.basis,
                reason: options.reason ?? 'local_scan',
                published_at: stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
                doc_type: suffix.slice(1),
            });
        }
    };
    walk(resolve(dir), 0);
    return out;
}
export function fromExplicit(location) {
    const raw = (location ?? '').trim();
    if (!raw)
        return [];
    if (/^https?:\/\//i.test(raw)) {
        if (isPaywalledOrLogin(raw)) {
            return [{
                    location: raw, title: '', source_type: 'web_page', quality: 0,
                    quality_basis: '需要登录/付费墙，插件不绕过访问控制', reason: 'paywalled', published_at: '', doc_type: 'text',
                }];
        }
        const described = sourceQuality(classifySource(raw), raw);
        return [{
                location: raw, title: '', source_type: classifySource(raw),
                quality: described.quality, quality_basis: described.basis, reason: 'explicit',
                published_at: '', doc_type: 'text',
            }];
    }
    const absolute = isAbsolute(raw) ? raw : resolve(raw);
    let stat;
    try {
        stat = statSync(absolute);
    }
    catch {
        return [{
                location: raw, title: '', source_type: 'unknown', quality: 0, quality_basis: '路径不存在',
                reason: 'not_found', published_at: '', doc_type: 'text',
            }];
    }
    if (stat.isDirectory())
        return scanLocal(absolute, { reason: 'dir_from_agent' });
    const described = sourceQuality(classifySource(absolute), absolute);
    return [{
            location: absolute,
            title: absolute.split('/').pop() ?? '',
            source_type: classifySource(absolute, { docType: suffixOf(absolute).slice(1) }),
            quality: described.quality, quality_basis: described.basis, reason: 'explicit',
            published_at: stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            doc_type: suffixOf(absolute).slice(1),
        }];
}
export async function discover(options = {}) {
    const limit = Math.min(Math.max(1, options.limit ?? 30), 200);
    const warnings = [];
    const found = [];
    for (const location of options.explicitLocations ?? []) {
        found.push(...fromExplicit(location));
    }
    if (options.includeCorpus !== false && options.corpusDir) {
        const keywords = options.keywords ?? options.topics ?? [];
        found.push(...scanLocal(options.corpusDir, { keywords, limit: 200, reason: 'corpus_scan' }));
    }
    if (options.search) {
        if (!options.allowNetwork) {
            warnings.push('未开启 security.allow_network，已跳过 web 搜索通道');
        }
        else {
            for (const topic of (options.topics ?? []).slice(0, 5)) {
                try {
                    const results = await options.search(topic, Math.min(limit, 8));
                    for (const item of results) {
                        found.push(...fromExplicit(item.url));
                    }
                }
                catch (error) {
                    warnings.push(`搜索「${topic}」失败: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    const byKey = new Map();
    const notFound = [];
    for (const candidate of found) {
        if (candidate.reason === 'not_found' || candidate.reason === 'paywalled') {
            notFound.push(candidate.location);
            continue;
        }
        const key = normalizeLocation(candidate.location);
        const existing = byKey.get(key);
        if (!existing || candidate.quality > existing.quality)
            byKey.set(key, candidate);
    }
    for (const item of notFound)
        warnings.push(`不可用来源已跳过: ${item}`);
    const candidates = [...byKey.values()].sort((a, b) => b.quality - a.quality || a.location.localeCompare(b.location));
    return {
        candidates: candidates.slice(0, limit),
        total_found: found.length,
        total_after_dedupe: candidates.length,
        returned: Math.min(candidates.length, limit),
        warnings,
    };
}
