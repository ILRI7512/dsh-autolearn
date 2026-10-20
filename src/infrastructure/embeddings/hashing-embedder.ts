/**
 * 特征哈希向量化（确定性、离线，**不是**神经语义模型）。
 *
 * 与 Python `HashingEmbedder` 完全一致：
 * - token = 分词器输出（拉丁词 + 中文 bigram）；
 * - 每个 token 取 blake2b-64 小端值：index = value % dim，sign = bit63；
 * - 权重 = 1 + ln(tf)（次线性）；
 * - 行向量 L2 归一化。
 * 因此 embedder_id 保持 `hashing:hashed-ngram:512`，旧索引可直接复用。
 */
import { blake2bUint64 } from './blake2b.ts'
import { tokenize } from '../retrieval/tokenizer.ts'

export interface Embedder {
  readonly provider: string
  readonly model: string
  readonly dim: number
  readonly embedderId: string
  embed(texts: readonly string[]): Float32Array[]
  describe(): Record<string, unknown>
}

export class HashingEmbedder implements Embedder {
  readonly provider = 'hashing'
  readonly model: string
  readonly dim: number
  readonly embedderId: string

  constructor(dim = 512, model = 'hashed-ngram') {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error('向量维度必须为正整数')
    this.dim = dim
    this.model = model || 'hashed-ngram'
    this.embedderId = `${this.provider}:${this.model}:${this.dim}`
  }

  private hash(token: string): { index: number; sign: number } {
    const value = blake2bUint64(token)
    const index = Number(value % BigInt(this.dim))
    const sign = ((value >> 63n) & 1n) === 1n ? 1 : -1
    return { index, sign }
  }

  embed(texts: readonly string[]): Float32Array[] {
    const out: Float32Array[] = []
    for (const text of texts) {
      const vector = new Float64Array(this.dim)
      const counts = new Map<string, number>()
      for (const token of tokenize(text ?? '')) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const [token, count] of counts) {
        const { index, sign } = this.hash(token)
        vector[index] = (vector[index] as number) + sign * (1 + Math.log(count))
      }
      out.push(normalizeToFloat32(vector))
    }
    return out
  }

  describe(): Record<string, unknown> {
    return {
      provider: this.provider,
      model: this.model,
      dim: this.dim,
      note: '本地特征哈希，非神经网络语义模型；可在离线环境确定性复现',
    }
  }
}

export function normalizeToFloat32(vector: Float64Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  const out = new Float32Array(vector.length)
  if (norm === 0) return out
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] as number) / norm
  return out
}

export function normalizeInPlace(vector: Float32Array): void {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0) return
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm
}
