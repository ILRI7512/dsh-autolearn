/**
 * 安全公式求值：自写表达式解析器，**不使用 eval / Function**。
 *
 * 支持：+ - * / % ^、括号、一元正负、常量 pi/e、
 *      函数 min max sqrt abs log ln exp round floor ceil sin cos tan pow。
 * 未知标识符、非法字符、非有限结果一律抛 FormulaError——绝不执行任意代码。
 */
export class FormulaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FormulaError';
    }
}
const CONSTANTS = { pi: Math.PI, e: Math.E };
const FUNCTIONS = {
    min: (...args) => Math.min(...args),
    max: (...args) => Math.max(...args),
    sqrt: (x) => Math.sqrt(x),
    abs: (x) => Math.abs(x),
    log: (x) => Math.log10(x),
    ln: (x) => Math.log(x),
    exp: (x) => Math.exp(x),
    round: (x, digits = 0) => {
        const factor = 10 ** digits;
        return Math.round(x * factor) / factor;
    },
    floor: (x) => Math.floor(x),
    ceil: (x) => Math.ceil(x),
    sin: (x) => Math.sin(x),
    cos: (x) => Math.cos(x),
    tan: (x) => Math.tan(x),
    pow: (x, y) => x ** y,
};
function tokenize(expression) {
    const tokens = [];
    let index = 0;
    while (index < expression.length) {
        const char = expression[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (/[0-9.]/.test(char)) {
            let end = index;
            while (end < expression.length && /[0-9._]/.test(expression[end]))
                end += 1;
            // 支持科学计数法 1e-3
            if (expression[end] === 'e' || expression[end] === 'E') {
                let probe = end + 1;
                if (expression[probe] === '+' || expression[probe] === '-')
                    probe += 1;
                if (/[0-9]/.test(expression[probe] ?? '')) {
                    end = probe;
                    while (end < expression.length && /[0-9]/.test(expression[end]))
                        end += 1;
                }
            }
            const text = expression.slice(index, end).replace(/_/g, '');
            const value = Number.parseFloat(text);
            if (!Number.isFinite(value))
                throw new FormulaError(`非法数字: ${text}`);
            tokens.push({ kind: 'number', value });
            index = end;
            continue;
        }
        if (/[A-Za-z_\u4e00-\u9fff]/.test(char)) {
            let end = index;
            while (end < expression.length && /[A-Za-z0-9_\u4e00-\u9fff]/.test(expression[end]))
                end += 1;
            tokens.push({ kind: 'ident', value: expression.slice(index, end) });
            index = end;
            continue;
        }
        if ('+-*/%^(),'.includes(char)) {
            tokens.push({ kind: 'op', value: char });
            index += 1;
            continue;
        }
        throw new FormulaError(`表达式包含非法字符: ${char}`);
    }
    return tokens;
}
export function evaluateFormula(expression, variables = {}) {
    if (!expression || !expression.trim())
        throw new FormulaError('公式表达式为空');
    if (expression.length > 500)
        throw new FormulaError('公式过长（>500 字符），拒绝求值');
    const tokens = tokenize(expression);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const consume = () => {
        const token = tokens[cursor];
        if (!token)
            throw new FormulaError('表达式意外结束');
        cursor += 1;
        return token;
    };
    const expect = (value) => {
        const token = consume();
        if (token.kind !== 'op' || token.value !== value)
            throw new FormulaError(`期望 ${value}`);
    };
    const parseExpression = () => parseAdditive();
    function parseAdditive() {
        let left = parseMultiplicative();
        for (;;) {
            const token = peek();
            if (token?.kind === 'op' && (token.value === '+' || token.value === '-')) {
                consume();
                const right = parseMultiplicative();
                left = token.value === '+' ? left + right : left - right;
            }
            else
                return left;
        }
    }
    function parseMultiplicative() {
        let left = parseUnary();
        for (;;) {
            const token = peek();
            if (token?.kind === 'op' && (token.value === '*' || token.value === '/' || token.value === '%')) {
                consume();
                const right = parseUnary();
                if (token.value === '*')
                    left *= right;
                else if (token.value === '/') {
                    if (right === 0)
                        throw new FormulaError('除以零');
                    left /= right;
                }
                else {
                    if (right === 0)
                        throw new FormulaError('对零取模');
                    left %= right;
                }
            }
            else
                return left;
        }
    }
    function parseUnary() {
        const token = peek();
        if (token?.kind === 'op' && (token.value === '+' || token.value === '-')) {
            consume();
            const value = parseUnary();
            return token.value === '-' ? -value : value;
        }
        return parsePower();
    }
    function parsePower() {
        const base = parsePrimary();
        const token = peek();
        if (token?.kind === 'op' && token.value === '^') {
            consume();
            const exponent = parseUnary();
            return base ** exponent;
        }
        return base;
    }
    function parsePrimary() {
        const token = consume();
        if (token.kind === 'number')
            return token.value;
        if (token.kind === 'op' && token.value === '(') {
            const value = parseExpression();
            expect(')');
            return value;
        }
        if (token.kind === 'ident') {
            const name = token.value;
            const next = peek();
            if (next?.kind === 'op' && next.value === '(') {
                consume();
                const args = [];
                if (!(peek()?.kind === 'op' && peek().value === ')')) {
                    for (;;) {
                        args.push(parseExpression());
                        const separator = peek();
                        if (separator?.kind === 'op' && separator.value === ',') {
                            consume();
                            continue;
                        }
                        break;
                    }
                }
                expect(')');
                const fn = FUNCTIONS[name];
                if (!fn)
                    throw new FormulaError(`未知函数: ${name}`);
                return fn(...args);
            }
            if (name in CONSTANTS)
                return CONSTANTS[name];
            if (name in variables) {
                const value = Number(variables[name]);
                if (!Number.isFinite(value))
                    throw new FormulaError(`变量 ${name} 不是有限数值`);
                return value;
            }
            throw new FormulaError(`未知变量或常量: ${name}`);
        }
        throw new FormulaError(`无法解析的记号: ${JSON.stringify(token)}`);
    }
    const result = parseExpression();
    if (cursor !== tokens.length)
        throw new FormulaError('表达式存在多余内容');
    if (!Number.isFinite(result))
        throw new FormulaError('求值结果不是有限数值');
    return result;
}
