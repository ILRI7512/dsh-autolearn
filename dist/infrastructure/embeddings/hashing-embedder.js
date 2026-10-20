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
import { blake2bUint64 } from "./blake2b.js";
import { tokenize } from "../retrieval/tokenizer.js";
export class HashingEmbedder {
    provider = 'hashing';
    model;
    dim;
    embedderId;
    constructor(dim = 512, model = 'hashed-ngram') {
        if (!Number.isInteger(dim) || dim <= 0)
            throw new Error('向量维度必须为正整数');
        this.dim = dim;
        this.model = model || 'hashed-ngram';
        this.embedderId = `${this.provider}:${this.model}:${this.dim}`;
    }
    hash(token) {
        const value = blake2bUint64(token);
        const index = Number(value % BigInt(this.dim));
        const sign = ((value >> 63n) & 1n) === 1n ? 1 : -1;
        return { index, sign };
    }
    embed(texts) {
        const out = [];
        for (const text of texts) {
            const vector = new Float64Array(this.dim);
            const counts = new Map();
            for (const token of tokenize(text ?? ''))
                counts.set(token, (counts.get(token) ?? 0) + 1);
            for (const [token, count] of counts) {
                const { index, sign } = this.hash(token);
                vector[index] = vector[index] + sign * (1 + Math.log(count));
            }
            out.push(normalizeToFloat32(vector));
        }
        return out;
    }
    describe() {
        return {
            provider: this.provider,
            model: this.model,
            dim: this.dim,
            note: '本地特征哈希，非神经网络语义模型；可在离线环境确定性复现',
        };
    }
}
export function normalizeToFloat32(vector) {
    let norm = 0;
    for (const value of vector)
        norm += value * value;
    norm = Math.sqrt(norm);
    const out = new Float32Array(vector.length);
    if (norm === 0)
        return out;
    for (let i = 0; i < vector.length; i += 1)
        out[i] = vector[i] / norm;
    return out;
}
export function normalizeInPlace(vector) {
    let norm = 0;
    for (const value of vector)
        norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0)
        return;
    for (let i = 0; i < vector.length; i += 1)
        vector[i] = vector[i] / norm;
}
