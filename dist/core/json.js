/** JSON 安全解析与常用兜底：坏数据不抛到业务层，返回显式 fallback。 */
export function parseJsonObject(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
        return raw;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                return parsed;
        }
        catch {
            return {};
        }
    }
    return {};
}
export function parseJsonArray(raw) {
    if (Array.isArray(raw))
        return raw;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            return [];
        }
    }
    return [];
}
export function asString(value, fallback = '') {
    return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}
export function asNumber(value, fallback = 0) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}
export function asBool(value, fallback = false) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return value !== 0;
    if (typeof value === 'string')
        return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    return fallback;
}
/** 限制写入数据库/返回给模型的字符串长度（截断而不是抛错，行为与旧版一致）。 */
export function truncate(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
