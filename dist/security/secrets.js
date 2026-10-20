/** 密钥/令牌扫描与日志脱敏（写入知识库前的硬闸门）。 */
export const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
/** 返回命中的模式描述，未命中返回 null。 */
export function containsSecret(text) {
    for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text ?? ''))
            return pattern.source;
    }
    return null;
}
const SENSITIVE_KEY_RE = /(api[_-]?key|secret|password|passwd|token|authorization|credential)/i;
/** 审计日志脱敏：递归处理敏感键，截断长字符串。 */
export function redact(value, depth = 0) {
    if (depth > 4)
        return '[depth-limit]';
    if (typeof value === 'string') {
        if (value.length > 1000)
            return `${value.slice(0, 1000)}…`;
        return containsSecret(value) ? '[redacted:secret]' : value;
    }
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => redact(item, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        let count = 0;
        for (const [key, item] of Object.entries(value)) {
            if (count >= 50)
                break;
            count += 1;
            out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redact(item, depth + 1);
        }
        return out;
    }
    return value;
}
