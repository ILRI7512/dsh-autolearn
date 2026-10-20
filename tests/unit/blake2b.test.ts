import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blake2b, blake2bUint64 } from '../../src/infrastructure/embeddings/blake2b.ts'
import { HashingEmbedder } from '../../src/infrastructure/embeddings/hashing-embedder.ts'
import { tokenize } from '../../src/infrastructure/retrieval/tokenizer.ts'

const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex')

describe('BLAKE2b（与 Python hashlib 对拍）', () => {
  it('8 字节摘要与 hashlib.blake2b(digest_size=8) 完全一致', () => {
    // 期望值由 python3 生成：hashlib.blake2b(s.encode(), digest_size=8).hexdigest()
    const vectors: Array<[string, string]> = [
      ['hello', 'a7b6eda801e5347d'],
      ['hello world', '878633aa32a3b150'],
      ['滑点', '3b0f2f60e576dea5'],
      ['c++', 'd9bf32f50aaaf1aa'],
      ['node.js', '3cf43610fd5f95dc'],
      ['', 'e4a6a0577479b2b4'],
    ]
    for (const [input, expected] of vectors) {
      assert.equal(hex(blake2b(new TextEncoder().encode(input), 8)), expected, input)
    }
  })

  it('跨块输入（>128 字节）与 64 字节摘要保持正确', () => {
    const long = 'a'.repeat(300)
    assert.equal(hex(blake2b(new TextEncoder().encode(long), 8)), '8b397aa4c75429a2')
    assert.equal(blake2b(new TextEncoder().encode('abc')).length, 64)
  })

  it('uint64 解码为小端无符号整数', () => {
    const value = blake2bUint64('滑点')
    assert.equal(value, 0xa5de76e5602f0f3bn)
  })
})

describe('特征哈希向量化', () => {
  it('确定性、L2 归一化、相同文本相同向量', () => {
    const embedder = new HashingEmbedder(512)
    const [a] = embedder.embed(['风险管理 滑点'])
    const [b] = embedder.embed(['风险管理 滑点'])
    assert.ok(a && b)
    assert.deepEqual([...a], [...b])
    let norm = 0
    for (const value of a) norm += value * value
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5)
  })

  it('embedder_id 与旧版一致（索引兼容的前提）', () => {
    assert.equal(new HashingEmbedder(512).embedderId, 'hashing:hashed-ngram:512')
  })

  it('空文本得到零向量而不是 NaN', () => {
    const [vector] = new HashingEmbedder(64).embed([''])
    assert.ok(vector)
    assert.ok([...vector].every((value) => value === 0))
  })

  it('中文 bigram 与拉丁词都参与哈希（不同文本向量不同）', () => {
    const embedder = new HashingEmbedder(256)
    const [a] = embedder.embed(['滑点与回测'])
    const [b] = embedder.embed(['杠杆与保证金'])
    assert.ok(a && b)
    assert.notDeepEqual([...a], [...b])
    assert.ok(tokenize('滑点与回测').includes('滑点'))
  })
})
