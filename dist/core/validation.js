/**
 * 运行时输入校验（JSON Schema 子集）。
 *
 * 为什么手写而不是引入 zod：
 * - 工具参数本身必须是 JSON Schema（DSH 原生工具与 MCP 都要求），
 *   同一份 schema 同时用于「模型可见契约」和「运行时校验」，只有一套真相；
 * - 零运行时依赖，插件在被 link 进 DSH profile 时可解析（profile 里没有本插件的 node_modules）；
 * - 校验规则有限且被单测覆盖，安全边界不依赖 TS 类型。
 *
 * 支持：type/properties/required/additionalProperties/enum/const/
 *       minimum/maximum/minLength/maxLength/pattern/minItems/maxItems/items/oneOf。
 */
import { isPlainObject } from "./json.js";
function typeOf(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    if (typeof value === 'number')
        return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
}
function typeMatches(expected, value) {
    const actual = typeOf(value);
    if (expected === 'number')
        return actual === 'number' || actual === 'integer';
    return actual === expected;
}
export function validateSchema(schema, value, path = '') {
    const violations = [];
    const label = path || '$';
    if (Array.isArray(schema.oneOf)) {
        const matches = schema.oneOf.filter((arm) => isPlainObject(arm) && validateSchema(arm, value, path).length === 0);
        if (matches.length !== 1) {
            violations.push({ path: label, message: 'must match exactly one of the allowed shapes' });
        }
        return violations;
    }
    if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
        violations.push({ path: label, message: `expected ${schema.type}, got ${typeOf(value)}` });
        return violations;
    }
    if ('const' in schema && value !== schema.const) {
        violations.push({ path: label, message: `must equal ${JSON.stringify(schema.const)}` });
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
        violations.push({ path: label, message: `must be one of ${JSON.stringify(schema.enum)}` });
    }
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            violations.push({ path: label, message: `length must be >= ${schema.minLength}` });
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            violations.push({ path: label, message: `length must be <= ${schema.maxLength}` });
        }
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
            violations.push({ path: label, message: `must match pattern ${schema.pattern}` });
        }
    }
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            violations.push({ path: label, message: `must be >= ${schema.minimum}` });
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            violations.push({ path: label, message: `must be <= ${schema.maximum}` });
        }
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            violations.push({ path: label, message: `must have >= ${schema.minItems} items` });
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            violations.push({ path: label, message: `must have <= ${schema.maxItems} items` });
        }
        if (isPlainObject(schema.items)) {
            value.forEach((item, index) => {
                violations.push(...validateSchema(schema.items, item, `${path}[${index}]`));
            });
        }
    }
    if (isPlainObject(value) && (schema.type === 'object' || isPlainObject(schema.properties))) {
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (typeof key === 'string' && !(key in value)) {
                violations.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    violations.push({ path: path ? `${path}.${key}` : key, message: 'is not allowed' });
                }
            }
        }
        for (const [key, sub] of Object.entries(properties)) {
            if (key in value && isPlainObject(sub)) {
                violations.push(...validateSchema(sub, value[key], path ? `${path}.${key}` : key));
            }
        }
    }
    return violations;
}
/** 校验失败直接抛出（调用方负责转成结构化错误）。 */
export function assertSchema(schema, value, what = 'input') {
    const violations = validateSchema(schema, value);
    if (violations.length > 0) {
        const detail = violations
            .slice(0, 10)
            .map((v) => `${v.path}: ${v.message}`)
            .join('; ');
        throw new Error(`${what} validation failed: ${detail}`);
    }
}
