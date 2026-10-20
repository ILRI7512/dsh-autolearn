import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateFormula, FormulaError } from '../../src/domain/practice/formula.ts'
import { readNpy, writeNpy } from '../../src/infrastructure/embeddings/npy.ts'
import { chunkText, detectLanguage, markdownToText, htmlToText, summarize } from '../../src/infrastructure/sources/parser.ts'

describe('安全公式求值（不使用 eval）', () => {
  it('四则运算与优先级', () => {
    assert.equal(evaluateFormula('1 + 2 * 3'), 7)
    assert.equal(evaluateFormula('(1 + 2) * 3'), 9)
    assert.equal(evaluateFormula('2 ^ 3 ^ 2'), 512)
    assert.equal(evaluateFormula('-3 + 1'), -2)
  })

  it('变量与函数', () => {
    assert.equal(evaluateFormula('(peak - now) / peak', { peak: 10000, now: 8000 }), 0.2)
    assert.equal(evaluateFormula('max(1, 5) + sqrt(9)'), 8)
    assert.equal(evaluateFormula('round(3.14159, 2)'), 3.14)
  })

  it('拒绝未知变量、未知函数、非法字符与除零', () => {
    assert.throws(() => evaluateFormula('a + 1'), FormulaError)
    assert.throws(() => evaluateFormula('evil(1)'), FormulaError)
    assert.throws(() => evaluateFormula('process.exit(1)'), FormulaError)
    assert.throws(() => evaluateFormula('1 / 0'), FormulaError)
    assert.throws(() => evaluateFormula('alert(1)'), FormulaError)
  })

  it('拒绝超长表达式（防解析型 DoS）', () => {
    assert.throws(() => evaluateFormula('1+' + '1+'.repeat(300) + '1'), FormulaError)
  })
})

describe('NPY 读写（旧索引可读）', () => {
  it('二维 float32 往返一致', () => {
    const rows = 3
    const cols = 4
    const data = new Float32Array(rows * cols)
    for (let i = 0; i < data.length; i += 1) data[i] = i / 10
    const buffer = writeNpy({ rows, cols, data })
    const parsed = readNpy(buffer)
    assert.equal(parsed.rows, rows)
    assert.equal(parsed.cols, cols)
    assert.deepEqual([...parsed.data], [...data])
  })

  it('拒绝非 npy 缓冲区', () => {
    assert.throws(() => readNpy(Buffer.from('not an npy file')), /magic/)
  })

  it('空矩阵可往返', () => {
    const parsed = readNpy(writeNpy({ rows: 0, cols: 512, data: new Float32Array(0) }))
    assert.equal(parsed.rows, 0)
    assert.equal(parsed.cols, 512)
  })
})

describe('解析与切块', () => {
  it('chunkText 保留重叠尾巴并合并短块', () => {
    const text = `${'第一段。'.repeat(60)}\n\n${'第二段。'.repeat(60)}`
    const chunks = chunkText(text, { chunkSize: 200, overlap: 40, minChars: 20 })
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) assert.ok(chunk.length <= 260)
  })

  it('空文本返回空数组', () => {
    assert.deepEqual(chunkText(''), [])
  })

  it('短块并入上一块', () => {
    const chunks = chunkText('A'.repeat(200) + '\n\n' + 'B'.repeat(10), { chunkSize: 900, minChars: 40 })
    assert.equal(chunks.length, 1)
  })

  it('语言检测与抽取式摘要', () => {
    assert.equal(detectLanguage('这是一段中文内容，用于检测语言分布情况，包含足够多的汉字。'), 'zh')
    assert.equal(detectLanguage('This is an English sentence with enough latin letters.'), 'en')
    const summary = summarize('第一句。第二句。第三句。'.repeat(20), 40)
    assert.ok(summary.endsWith('…'))
    assert.ok(summary.length <= 41)
  })

  it('HTML 清洗去掉脚本与标签，保留标题', () => {
    const { text, title } = htmlToText('<html><head><title>标题</title><script>alert(1)</script></head><body><p>正文 &amp; 内容</p></body></html>')
    assert.equal(title, '标题')
    assert.ok(text.includes('正文 & 内容'))
    assert.ok(!text.includes('alert(1)'))
  })

  it('Markdown 链接保留文字、图片丢弃', () => {
    const text = markdownToText('# 标题\n\n![img](a.png) [链接](https://example.com)\n\n> 引用\n')
    assert.ok(text.includes('链接'))
    assert.ok(!text.includes('img'))
    assert.ok(!text.includes('>'))
  })
})
