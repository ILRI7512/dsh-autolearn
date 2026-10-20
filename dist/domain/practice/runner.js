/**
 * 受限代码执行（lab 模式）。
 *
 * 默认 strict 沙盒：降权（nobody）+ 网络命名空间（unshare -n）+ Node Permission Model
 * （只允许读写产物目录，禁止 child_process/worker/addons/inspector）。
 * 能力不足时**失败关闭**，不会静默退回无隔离执行；只有显式配置 process 才使用旧行为。
 *
 * 明确边界：这是“权限 + 命名空间 + 运行时权限模型”的组合，不是 seccomp/LSM 内核沙箱。
 */
import { spawn } from 'node:child_process';
import { chownSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, utcnowIso } from "../../core/ids.js";
import { buildSandboxPlan, prepareArtifactDir, sandboxCapabilities, } from "../../security/sandbox.js";
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_PATH'];
function pickEnv(artifactDir) {
    const env = {};
    for (const key of ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    // 不继承 API Key；HOME/TMPDIR 指向产物目录，避免写入用户目录。
    env.HOME = artifactDir;
    env.TMPDIR = artifactDir;
    return env;
}
export class CodeTestRunner {
    options;
    constructor(options) {
        this.options = options;
    }
    async run(code, options = {}) {
        const experimentsDir = options.experimentsDir ?? this.options.experimentsDir;
        const timeoutSeconds = options.timeoutSeconds ?? this.options.timeoutSeconds;
        const maxOutput = options.maxOutputBytes ?? this.options.maxOutputBytes;
        const sandboxMode = options.sandboxMode ?? this.options.sandboxMode;
        const memoryMb = options.memoryMb ?? this.options.memoryMb;
        const artifactMb = options.artifactMb ?? this.options.artifactMb;
        const language = (options.language ?? 'javascript').toLowerCase();
        const started = Date.now();
        const artifactDir = join(experimentsDir, newId('exp'));
        mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
        const scriptPath = join(artifactDir, 'main.mjs');
        writeFileSync(scriptPath, code, 'utf8');
        writeFileSync(join(artifactDir, 'spec.json'), `${JSON.stringify({ language, created_at: utcnowIso(), trusted: options.trusted ?? false, sandbox: sandboxMode }, null, 2)}\n`, 'utf8');
        if (!['javascript', 'js', 'mjs', 'node', 'typescript', 'ts'].includes(language)) {
            return {
                ok: false, status: 'error', exit_code: null, timed_out: false, duration_ms: 0,
                stdout: '', stderr: `不支持的语言: ${language}（只执行 JavaScript；Python 运行时已移除）`,
                environment: { node: process.version },
                isolation: 'not-run',
                sandbox: { mode: sandboxMode, executed: false },
                artifact_dir: artifactDir,
            };
        }
        const planResult = buildSandboxPlan({ mode: sandboxMode, scriptPath, artifactDir, memoryMb });
        if (!planResult.ok) {
            return {
                ok: false, status: 'error', exit_code: null, timed_out: false, duration_ms: Date.now() - started,
                stdout: '', stderr: planResult.error,
                environment: { node: process.version, platform: process.platform },
                isolation: 'unavailable',
                sandbox: { mode: sandboxMode, executed: false, error: planResult.error, capabilities: sandboxCapabilities() },
                artifact_dir: artifactDir,
            };
        }
        const plan = planResult.plan;
        prepareArtifactDir(artifactDir, plan);
        if (plan.dropUidTo !== undefined) {
            for (const file of [scriptPath, join(artifactDir, 'spec.json')]) {
                try {
                    chownSync(file, plan.dropUidTo, plan.dropUidTo);
                }
                catch {
                    /* 非 root/不支持时忽略；权限模型仍然生效 */
                }
            }
        }
        const result = await runProcess(plan.command, plan.args, {
            cwd: artifactDir,
            timeoutMs: timeoutSeconds * 1000,
            maxOutputBytes: maxOutput,
            env: pickEnv(artifactDir),
        });
        const duration = Date.now() - started;
        writeFileSync(join(artifactDir, 'stdout.txt'), result.stdout.slice(0, maxOutput), 'utf8');
        writeFileSync(join(artifactDir, 'stderr.txt'), result.stderr.slice(0, maxOutput), 'utf8');
        const artifactBytes = directorySize(artifactDir);
        const sizeLimit = Math.max(1, artifactMb) * 1024 * 1024;
        const oversized = artifactBytes > sizeLimit;
        const sandboxInfo = {
            mode: plan.mode,
            network_isolated: plan.networkIsolated,
            uid_dropped: plan.uidDropped,
            permission_model: plan.mode === 'strict',
            child_process: plan.mode === 'strict' ? 'disabled' : 'allowed',
            worker: plan.mode === 'strict' ? 'disabled' : 'allowed',
            artifact_bytes: artifactBytes,
            artifact_limit_bytes: sizeLimit,
            warnings: plan.warnings,
        };
        const ok = result.exitCode === 0 && !result.timedOut && !oversized;
        return {
            ok,
            status: result.timedOut ? 'timeout' : oversized ? 'fail' : ok ? 'pass' : 'fail',
            exit_code: result.exitCode,
            timed_out: result.timedOut,
            duration_ms: duration,
            stdout: result.stdout,
            stderr: oversized ? `${result.stderr}\n[沙盒] 产物目录超过上限 ${artifactMb}MB（${artifactBytes} bytes）` : result.stderr,
            environment: {
                node: process.version, platform: process.platform, cwd: artifactDir,
                env_allowlist: [...ENV_ALLOWLIST, 'HOME', 'TMPDIR'],
            },
            isolation: plan.mode === 'strict' ? 'strict-sandbox' : 'process-only',
            sandbox: sandboxInfo,
            artifact_dir: artifactDir,
        };
    }
}
function directorySize(dir, depth = 0) {
    if (depth > 6)
        return 0;
    let total = 0;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        try {
            const stat = statSync(full);
            if (stat.isDirectory())
                total += directorySize(full, depth + 1);
            else if (stat.isFile())
                total += stat.size;
        }
        catch {
            /* 运行中被删除的文件忽略 */
        }
    }
    return total;
}
function runProcess(command, args, options) {
    return new Promise((resolve) => {
        const detached = process.platform !== 'win32';
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const killTree = () => {
            try {
                if (detached && child.pid !== undefined)
                    process.kill(-child.pid, 'SIGKILL');
                else
                    child.kill('SIGKILL');
            }
            catch {
                try {
                    child.kill('SIGKILL');
                }
                catch { /* 已退出 */ }
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killTree();
        }, options.timeoutMs);
        const collect = (target) => (chunk) => {
            const text = chunk.toString('utf8');
            if (target === 'stdout') {
                if (stdout.length < options.maxOutputBytes)
                    stdout += text.slice(0, options.maxOutputBytes - stdout.length);
            }
            else if (stderr.length < options.maxOutputBytes) {
                stderr += text.slice(0, options.maxOutputBytes - stderr.length);
            }
        };
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: null, timedOut, stdout, stderr: `${stderr}\nspawn error: ${error.message}` });
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode: code, timedOut, stdout, stderr });
        });
    });
}
