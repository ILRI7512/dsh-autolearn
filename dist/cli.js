#!/usr/bin/env node
/**
 * 用户侧 CLI：审批高风险操作、查看状态。
 *
 * 为什么需要它：MCP / 独立运行时的高风险操作走本地确认令牌，而**批准必须由用户侧完成**；
 * 模型可见工具没有 approve。本 CLI 就是那个 user-only 通道。
 */
import { AutolearnEngine } from "./index.js";
import { resolveEngineHome } from "./adapters/dsh/plugin.js";
import { describeError } from "./core/errors.js";
function usage() {
    console.log(`用法:
  dsh-autolearn pending                     列出待确认操作
  dsh-autolearn approve <token>             批准（仅本次、作用域绑定）
  dsh-autolearn reject <token> [note]       拒绝
  dsh-autolearn status [projectId]          查看引擎/项目状态
  dsh-autolearn diagnostics                 数据库/索引一致性诊断
  dsh-autolearn search <query> [projectId]  检索知识库
环境变量：DSH_AL_HOME（引擎目录，默认自动探测）`);
}
function print(value) {
    console.log(JSON.stringify(value, null, 2));
}
export async function main(argv = process.argv.slice(2)) {
    const command = argv[0] ?? 'help';
    if (command === 'help' || command === '--help' || command === '-h') {
        usage();
        return 0;
    }
    let engine;
    try {
        engine = AutolearnEngine.open({ home: resolveEngineHome() });
    }
    catch (error) {
        console.error(`引擎启动失败: ${describeError(error).error.message}`);
        return 1;
    }
    try {
        switch (command) {
            case 'pending': {
                print(engine.approval.pending());
                return 0;
            }
            case 'approve': {
                const token = argv[1];
                if (!token) {
                    console.error('缺少 token');
                    return 2;
                }
                const ok = engine.approval.approve(token, 'cli');
                print({ approved: ok, token });
                return ok ? 0 : 1;
            }
            case 'reject': {
                const token = argv[1];
                if (!token) {
                    console.error('缺少 token');
                    return 2;
                }
                const ok = engine.approval.reject(token, argv.slice(2).join(' '));
                print({ rejected: ok, token });
                return ok ? 0 : 1;
            }
            case 'status': {
                print(engine.services.learningStatus({ projectId: argv[1] }));
                return 0;
            }
            case 'diagnostics': {
                print(engine.services.systemDiagnostics());
                return 0;
            }
            case 'search': {
                const query = argv[1];
                if (!query) {
                    console.error('缺少 query');
                    return 2;
                }
                print(engine.services.knowledgeSearch({ query, projectId: argv[2], topK: 5 }));
                return 0;
            }
            default:
                usage();
                return 2;
        }
    }
    finally {
        engine.close();
    }
}
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('cli.js') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('cli.ts');
if (invokedDirectly) {
    main().then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        console.error(describeError(error).error.message);
        process.exitCode = 1;
    });
}
