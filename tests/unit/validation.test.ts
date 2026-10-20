import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateSchema, type JsonSchema } from '../../src/core/validation.ts'
import { contentFingerprint, makeChunkId, normalizeText, stableHash } from '../../src/core/ids.ts'

const schema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 10 },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['name'],
  additionalProperties: false,
}

describe('运行时输入校验', () => {
  it('合法输入通过', () => {
    assert.deepEqual(validateSchema(schema, { name: 'ok', count: 3, mode: 'a', tags: ['x'] }), [])
  })

  it('拒绝缺失必填、类型错误、越界、额外字段', () => {
    const violations = validateSchema(schema, { count: 9, mode: 'c', extra: true, tags: ['x', 'y', 'z'] })
    const paths = violations.map((v) => v.path)
    assert.ok(paths.includes('name'))
    assert.ok(paths.includes('count'))
    assert.ok(paths.includes('mode'))
    assert.ok(paths.includes('extra'))
    assert.ok(paths.some((path) => path.startsWith('tags')))
  })

  it('数组元素逐个校验并报告索引路径', () => {
    const violations = validateSchema(schema, { name: 'ok', tags: [1] })
    assert.ok(violations.some((v) => v.path === 'tags[0]'))
  })

  it('oneOf 只允许恰好一个分支', () => {
    const union: JsonSchema = {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false },
      ],
    }
    assert.equal(validateSchema(union, { a: 'x' }).length, 0)
    assert.ok(validateSchema(union, { a: 'x', b: 1 }).length > 0)
    assert.ok(validateSchema(union, {}).length > 0)
  })
})

describe('指纹与归一化（跨语言兼容）', () => {
  it('normalizeText 去零宽/压缩空白', () => {
    // 与 Python 版逐字一致：空白压缩后行尾空格保留，再压缩空行并 strip
    assert.equal(normalizeText('  a\u200b  b \n\n\n\n c  '), 'a b \n\n c')
  })

  it('contentFingerprint 只由正文决定（跨文档可去重）', () => {
    assert.equal(contentFingerprint('同一段 文字'), contentFingerprint('同一段 文字'))
    assert.notEqual(contentFingerprint('A'), contentFingerprint('B'))
  })

  it('makeChunkId 对同项目同内容幂等', () => {
    const hash = contentFingerprint('内容')
    assert.equal(makeChunkId('p1', hash), makeChunkId('p1', hash))
    assert.notEqual(makeChunkId('p1', hash), makeChunkId('p2', hash))
  })

  it('stableHash 输出长度可控', () => {
    assert.equal(stableHash('x', 24).length, 24)
    assert.match(stableHash('x'), /^[0-9a-f]{64}$/)
  })
})
