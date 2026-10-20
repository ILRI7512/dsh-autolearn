/** ID、哈希与文本归一化：与 Python 版逐字节一致（跨语言指纹兼容）。 */
import { createHash, randomBytes } from 'node:crypto'

export function utcnowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

export function stableHash(text: string, length = 64): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length)
}

/** 归一化文本用于指纹/关键词：去零宽字符、压缩空白。 */
export function normalizeText(text: string): string {
  return (text ?? '')
    .replace(/\u200b/g, '')
    .replace(/\ufeff/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 内容指纹：只由正文决定，不含来源/文档 ID（跨文档去重的关键）。 */
export function contentFingerprint(text: string): string {
  return stableHash(normalizeText(text))
}

/** 知识片段 ID：项目 + 内容指纹 → 同一内容在同一项目内是同一实体（幂等）。 */
export function makeChunkId(projectId: string, contentHash: string): string {
  return `chunk_${stableHash(`${projectId}|${contentHash}`, 24)}`
}

export function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value))
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}
