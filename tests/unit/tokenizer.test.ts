import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bm25Scores, expandQuery, tokenize, jaccard } from '../../src/infrastructure/retrieval/tokenizer.ts'

describe('分词器（中文可检索的关键）', () => {
  it('中文按 bigram 切分，单字保留', () => {
    assert.deepEqual(tokenize('滑点'), ['滑点'])
    assert.deepEqual(tokenize('风'), ['风'])
  })

  it('拉丁词保留 c++/node.js 这类术语，去停用词', () => {
    const tokens = tokenize('The c++ and node.js runtime for the engine')
    assert.ok(tokens.includes('c++'))
    assert.ok(tokens.includes('node.js'))
    assert.ok(!tokens.includes('the'))
  })

  it('大小写归一，但中文取原文', () => {
    assert.deepEqual(tokenize('Risk MANAGEMENT'), ['risk', 'management'])
  })

  it('expandQuery 去重保序', () => {
    assert.deepEqual(expandQuery('滑点 滑点 风险'), ['滑点', '风险'])
  })

  it('空输入返回空数组（不抛错）', () => {
    assert.deepEqual(tokenize(''), [])
  })

  it('jaccard 计算正确', () => {
    assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1)
    assert.equal(jaccard(['a'], ['b']), 0)
  })
})

describe('BM25 纯函数', () => {
  it('相关文档分数高于无关文档，IDF 随 df 下降', () => {
    const docs = new Map<string, Map<string, number>>([
      ['d1', new Map([['滑点', 3], ['风险', 1]])],
      ['d2', new Map([['风险', 1], ['仓位', 1]])],
    ])
    const lengths = new Map([['d1', 4], ['d2', 2]])
    const scores = bm25Scores(['滑点'], docs, lengths, 2, 3)
    assert.ok((scores.get('d1') ?? 0) > 0)
    assert.equal(scores.get('d2'), undefined)
  })

  it('空查询或空语料返回空结果', () => {
    assert.equal(bm25Scores([], new Map(), new Map(), 0, 0).size, 0)
    assert.equal(bm25Scores(['x'], new Map(), new Map(), 0, 0).size, 0)
  })

  it('平均长度兜底为 1（不产生除零）', () => {
    const docs = new Map([['d1', new Map([['x', 1]])]])
    const scores = bm25Scores(['x'], docs, new Map(), 1, 0)
    assert.ok(Number.isFinite(scores.get('d1') ?? Number.NaN))
  })
})
