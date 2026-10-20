# 代码执行沙盒实现

## 1. 目标与结论

把 lab 模式的代码执行从“仅有进程隔离”升级为可验证的多层沙盒，并**明确它不是内核沙箱**。

在目标环境实测：

| 隔离层 | 机制 | 实测结果 |
| --- | --- | --- |
| 降权 | `setpriv --reuid=65534 --regid=65534` | 以 nobody 运行；无法向 root 进程发信号/改 root 文件 |
| 网络 | `unshare -n` | 新建网络命名空间，无路由/无 loopback |
| 文件系统 | Node `--permission --allow-fs-read/write=<产物目录>` | `/etc/passwd` 读取、`/tmp` 写入均 `ERR_ACCESS_DENIED` |
| 子进程 | 不开启 `--allow-child-process` | `child_process.execSync` `ERR_ACCESS_DENIED` |
| Worker/Addon/Inspector | 不开启对应 allow 标志 | 默认拒绝 |
| 资源 | `--max-old-space-size`、超时 SIGKILL（进程组）、输出截断、产物目录软上限 | 死循环 1s 内被杀；2MB 产物超过 1MB 上限判失败 |

## 2. 执行计划

```
root 运行：
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    unshare -n \
    node --permission --allow-fs-read=<artifact> --allow-fs-write=<artifact> \
         --max-old-space-size=<mb> <artifact>/main.mjs

非 root 运行：
  unshare -n node --permission ... <artifact>/main.mjs
```

- 环境变量白名单（PATH/LANG/LC_ALL/TZ/NODE_PATH），`HOME`/`TMPDIR` 指向产物目录；不继承 API Key。
- 产物目录创建后 chown 给 65534（root 场景），脚本文件同步 chown。
- 超时时杀掉**整个进程组**（detached + `kill(-pid)`），避免 setpriv/unshare/node 残留。
- 能力探测不是只看版本号：实际跑一个临时脚本验证 `--permission` 可用；`unshare`/`setpriv` 用 `--version` 探测并缓存。

## 3. 失败关闭（关键）

- 默认 `security.exec_sandbox = "strict"`。
- 若缺少 `unshare` / `setpriv`（root）或 Node 不支持 `--permission`：执行返回 `status=error`，错误说明缺失项，**不会**自动退回无沙盒执行。
- `security.exec_sandbox = "process"` 是显式降级，结果中标记 `isolation=process-only` 并带 warning；用于不支持命名空间的平台。
- 新增 `security.exec_artifact_mb`（默认 16）作为产物目录软上限，超出判失败。

## 4. 测试（9 项，全部通过）

文件：`tests/security/sandbox.test.ts`

| 用例 | 断言 |
| --- | --- |
| 逃逸探针（strict） | 读 `/etc/passwd`、写 `/tmp`、`child_process`、网络连接全部非 ALLOWED；产物目录内写入 ALLOWED |
| 超时 | `while(true)` 1s 内被终止，`timed_out=true`，无残留 |
| 产物配额 | 写 2MB、上限 1MB → 失败并提示超出上限 |
| 计划构建 | strict 计划包含 setpriv/unshare/-n/--permission，且不含 allow-child-process/worker |
| 能力不足 | strict 返回错误并提示可显式使用 process，不静默降级 |
| process 模式 | 明确标记 process-only；测试证明可读 `/etc/passwd`（说明它确实无沙盒） |
| 诊断 | `systemDiagnostics().execution` 暴露三层能力与边界声明 |

运行：

```bash
node --test tests/security/sandbox.test.ts
# 9 tests / 9 pass
```

全量：`npm test` → **171 tests / 42 suites / 0 fail**。

## 5. 配置

```json
{
  "security": {
    "exec_sandbox": "strict",
    "exec_memory_mb": 512,
    "exec_artifact_mb": 16,
    "exec_timeout_s": 10
  }
}
```

- `strict`：默认；能力不足时失败关闭。
- `process`：显式降级；仅进程隔离 + env 白名单 + 超时 + 输出截断。
- 非 root 部署：`unshare -n` 依赖用户命名空间；若内核禁止会失败关闭。root 部署额外要求 `setpriv`。

## 6. 明确边界（不夸大）

1. **不是 seccomp/LSM 内核沙箱**：没有系统调用过滤；依赖 Node Permission Model + 命名空间 + uid。
2. **不是容器**：共享内核、共享文件系统视图；权限模型是主要文件边界。
3. **磁盘是软配额**：执行后检查产物大小，不能在写入过程中实时阻断。
4. **只支持 JavaScript**；Python 执行已移除。
5. **依赖宿主工具**：`unshare`、`setpriv`（root）、支持 Permission Model 的 Node（本机 v24.19 验证）。
6. 恶意代码仍可能消耗 CPU/内存直到超时/OOM 限制；生产建议外层再加容器/cgroup。

## 7. 回滚

- 代码回滚：`git checkout main -- src/security/sandbox.ts src/domain/practice/runner.ts` 等；重新 build。
- 行为回滚：把 `security.exec_sandbox` 设为 `process`（显式降级，仍保留 env/超时/输出限制）。
- 无数据格式变化，不需要数据迁移。
