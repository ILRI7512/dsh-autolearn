#!/usr/bin/env node
/**
 * 可选 MCP 兼容适配器（stdio JSON-RPC 2.0）。
 *
 * 用途：非 DSH 的 MCP 客户端（或旧配置）仍可接入；它调用**同一个** TS 引擎，
 * 不复制业务逻辑。默认不启用（DSH profile 只挂原生工具），避免双写。
 *
 * 协议子集：initialize / notifications/initialized / tools/list / tools/call / ping。
 * 日志只写 stderr（stdout 属于协议通道）。
 */
import { createInterface } from 'node:readline';
import { AutolearnEngine } from "../../index.js";
import { buildNativeTools } from "../dsh/tools.js";
import { resolveEngineHome } from "../dsh/plugin.js";
import { describeError } from "../../core/errors.js";
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'dsh-autolearn', version: '2.0.0' };
function log(message) {
    process.stderr.write(`[dsh-autolearn-mcp] ${message}\n`);
}
export class McpServer {
    engine;
    tools;
    initialized = false;
    constructor(engine) {
        this.engine = engine;
        this.tools = buildNativeTools({
            services: engine.services,
            maxOutputBytes: engine.config.security.max_output_bytes,
        });
    }
    toolList() {
        return this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
        }));
    }
    async callTool(name, args) {
        const tool = this.tools.find((item) => item.name === name);
        if (!tool) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `未知工具: ${name}` } }) }] };
        }
        const value = await tool.execute(args);
        const failed = typeof value === 'object' && value !== null && value.ok === false;
        return {
            isError: failed,
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        };
    }
    async handle(request) {
        const id = request.id ?? null;
        const method = request.method ?? '';
        if (method.startsWith('notifications/'))
            return null;
        try {
            switch (method) {
                case 'initialize':
                    this.initialized = true;
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: PROTOCOL_VERSION,
                            capabilities: { tools: { listChanged: false } },
                            serverInfo: SERVER_INFO,
                            instructions: '自主学习引擎：知识检索/核验/学习任务。核验需要证据；模型不能自称人工复核。',
                        },
                    };
                case 'ping':
                    return { jsonrpc: '2.0', id, result: {} };
                case 'tools/list':
                    return { jsonrpc: '2.0', id, result: { tools: this.toolList() } };
                case 'tools/call': {
                    if (!this.initialized) {
                        return { jsonrpc: '2.0', id, error: { code: -32002, message: 'server not initialized' } };
                    }
                    const name = String(request.params?.name ?? '');
                    const args = (request.params?.arguments ?? {});
                    const result = await this.callTool(name, args);
                    return { jsonrpc: '2.0', id, result };
                }
                default:
                    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
            }
        }
        catch (error) {
            return { jsonrpc: '2.0', id, error: { code: -32603, message: describeError(error).error.message } };
        }
    }
    async serve() {
        const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
        for await (const line of rl) {
            const text = line.trim();
            if (!text)
                continue;
            let request;
            try {
                request = JSON.parse(text);
            }
            catch {
                process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
                continue;
            }
            const response = await this.handle(request);
            if (response)
                process.stdout.write(`${JSON.stringify(response)}\n`);
        }
    }
    close() {
        this.engine.close();
    }
}
export function main() {
    let engine;
    try {
        engine = AutolearnEngine.open({ home: resolveEngineHome(), hostApproval: false });
    }
    catch (error) {
        log(`引擎启动失败: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }
    const server = new McpServer(engine);
    log(`ready tools=${server.toolList().length} data=${engine.config.paths.data_dir}`);
    const shutdown = () => {
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    server.serve().then(() => {
        server.close();
    }).catch((error) => {
        log(`服务异常: ${error instanceof Error ? error.message : String(error)}`);
        server.close();
        process.exitCode = 1;
    });
}
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('mcp/server.js') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('mcp/server.ts') ||
    process.env.DSH_AL_MCP_MAIN === '1';
if (invokedDirectly)
    main();
