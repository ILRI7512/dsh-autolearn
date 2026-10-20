/**
 * 文档解析与切块：算法与 v1.2 一致（段落 → 句子 → 贪心合并 → 重叠尾巴）。
 *
 * 已知差异（诚实标注）：HTML 解析不使用 DOM 库，改为正则清洗；
 * PDF/DOCX 在 TS 运行时**不支持**（没有纯 JS 依赖），会明确报错而不是静默降级。
 */
import { normalizeText } from "../../core/ids.js";
export const CHUNK_DEFAULTS = { chunkSize: 900, overlap: 120, minChars: 40, maxChunks: 400 };
export function splitSections(text) {
    const lines = (text ?? '').split('\n');
    const sections = [];
    let heading = '';
    let level = 0;
    let buffer = [];
    let index = 0;
    const flush = () => {
        const body = buffer.join('\n').trim();
        if (body || heading)
            sections.push({ heading, level, index, text: body });
        index += 1;
        buffer = [];
    };
    for (const line of lines) {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (match) {
            flush();
            heading = match[2] ?? '';
            level = (match[1] ?? '').length;
        }
        else {
            buffer.push(line);
        }
    }
    flush();
    return sections.filter((section) => section.text.length > 0 || section.heading.length > 0);
}
export function extractCodeBlocks(text) {
    const blocks = [];
    const re = /```([A-Za-z0-9_+#.-]*)\n([\s\S]*?)```/g;
    for (const match of (text ?? '').matchAll(re)) {
        const language = (match[1] ?? '').toLowerCase() || 'text';
        const code = (match[2] ?? '').trimEnd();
        if (code.trim())
            blocks.push({ language, code });
    }
    return blocks;
}
function splitLongParagraph(paragraph, chunkSize, overlap) {
    const units = [];
    const sentences = paragraph.split(/(?<=[。！？.!?；;])\s*/).filter((item) => item.length > 0);
    let current = '';
    for (let sentence of sentences) {
        while (sentence.length > chunkSize) {
            units.push(sentence.slice(0, chunkSize));
            sentence = sentence.slice(Math.max(0, chunkSize - overlap));
        }
        if (!current)
            current = sentence;
        else if (current.length + sentence.length + 1 <= chunkSize)
            current += sentence;
        else {
            units.push(current);
            current = sentence;
        }
    }
    if (current)
        units.push(current);
    return units;
}
export function chunkText(text, options = {}) {
    const chunkSize = Math.max(120, Math.trunc(options.chunkSize ?? CHUNK_DEFAULTS.chunkSize));
    const overlap = Math.max(0, Math.min(Math.trunc(options.overlap ?? CHUNK_DEFAULTS.overlap), Math.floor(chunkSize / 2)));
    const minChars = Math.max(1, Math.trunc(options.minChars ?? CHUNK_DEFAULTS.minChars));
    const maxChunks = Math.max(1, Math.trunc(options.maxChunks ?? CHUNK_DEFAULTS.maxChunks));
    if (!text || !text.trim())
        return [];
    const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const units = [];
    for (const paragraph of paragraphs) {
        if (paragraph.length <= chunkSize)
            units.push(paragraph);
        else
            units.push(...splitLongParagraph(paragraph, chunkSize, overlap));
    }
    const chunks = [];
    let current = '';
    for (const unit of units) {
        if (!current) {
            current = unit;
            continue;
        }
        if (current.length + unit.length + 2 <= chunkSize) {
            current = `${current}\n\n${unit}`;
            continue;
        }
        chunks.push(current);
        const tail = overlap > 0 ? current.slice(-overlap) : '';
        current = tail ? `${tail}\n\n${unit}`.trim() : unit;
    }
    if (current)
        chunks.push(current);
    const cleaned = [];
    for (const chunk of chunks) {
        if (chunk.length < minChars && cleaned.length > 0) {
            cleaned[cleaned.length - 1] = `${cleaned[cleaned.length - 1]}\n\n${chunk}`;
        }
        else {
            cleaned.push(chunk);
        }
    }
    return cleaned.slice(0, maxChunks);
}
/** 抽取式摘要：不调用模型，只按整句截断。 */
export function summarize(text, maxChars = 160) {
    const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxChars)
        return collapsed;
    const sentences = collapsed.split(/(?<=[。！？.!?])\s*/);
    let out = '';
    for (const sentence of sentences) {
        if ((out + sentence).length > maxChars)
            break;
        out += sentence;
    }
    if (out)
        return `${out.trimEnd()}…`;
    return `${collapsed.slice(0, maxChars)}…`;
}
export function detectLanguage(text) {
    const sample = (text ?? '').slice(0, 4000);
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
    if (cjk === 0 && latin === 0)
        return 'unknown';
    return cjk >= Math.max(10, latin * 0.25) ? 'zh' : 'en';
}
const HTML_BLOCK_TAGS = /<\/?(p|div|section|article|li|br|tr|h[1-6])\b[^>]*>/gi;
const HTML_DROP = /<(script|style|nav|header|footer|aside|form|noscript|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** HTML → 纯文本（正则清洗；不执行脚本、不解析 DOM）。 */
export function htmlToText(html) {
    const source = html ?? '';
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
    const title = titleMatch?.[1] ? decodeEntities(stripTags(titleMatch[1])).trim() : '';
    let body = source.replace(/<!--[\s\S]*?-->/g, ' ');
    body = body.replace(HTML_DROP, ' ');
    body = body.replace(HTML_BLOCK_TAGS, '\n');
    body = stripTags(body);
    body = decodeEntities(body);
    body = body.replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text: body, title };
}
function stripTags(text) {
    return text.replace(/<[^>]+>/g, ' ');
}
function decodeEntities(text) {
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    };
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}
/** Markdown → 纯文本（链接保留文字，图片丢弃）。 */
export function markdownToText(markdown) {
    return (markdown ?? '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^ {0,3}> ?/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
const DOC_TYPES = {
    '.pdf': 'pdf', '.docx': 'docx', '.html': 'html', '.htm': 'html',
    '.md': 'markdown', '.markdown': 'markdown',
};
const CODE_EXTENSIONS = new Set([
    '.py', '.rs', '.kt', '.java', '.ts', '.tsx', '.js', '.jsx', '.go', '.c', '.cpp',
    '.h', '.cs', '.rb', '.php', '.sh', '.sql',
]);
export function docTypeOf(path) {
    const suffix = (path.slice(path.lastIndexOf('.')) || '').toLowerCase();
    if (DOC_TYPES[suffix])
        return DOC_TYPES[suffix];
    return CODE_EXTENSIONS.has(suffix) ? 'code' : 'text';
}
export function parseDocument(raw, docType) {
    if (docType === 'html') {
        const { text, title } = htmlToText(raw);
        return { text, title, parser: 'regex-html' };
    }
    if (docType === 'markdown') {
        return { text: markdownToText(raw), title: '', parser: 'markdown' };
    }
    if (docType === 'pdf' || docType === 'docx') {
        throw new Error(`解析 ${docType.toUpperCase()} 需要额外的解析库；TypeScript 运行时暂不支持（请先转换为 markdown/txt）`);
    }
    return { text: normalizeText(raw), title: '', parser: docType };
}
