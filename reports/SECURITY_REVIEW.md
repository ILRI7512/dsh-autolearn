# 安全与可靠性评审（vNext）

审计方式：代码阅读 + 攻击面探针 + 本地 HTTP 服务器实验 + 回归测试。所有“已修复”项都有修复前失败、修复后通过的测试。

## 1. 本轮发现与修复

### SEC-09（P0）IPv6 非规范写法绕过 SSRF 防护
- 位置：`src/security/network.ts::isPublicAddress`。
- 触发：抓取地址使用 `0:0:0:0:0:0:0:1`、`0:0:0:0:0:0:0:0`、`fec0::1`、`::ffff:7f00:1`、`0:0:0:0:0:ffff:127.0.0.1`、`64:ff9b::a00:1` 等非规范/十六进制映射写法。
- 影响：被判定为公网 → 可访问 loopback / site-local / IPv4-mapped 内网，绕过“拒绝私有地址”的核心防护。
- 证据：修复前探针输出这些地址均为 `true`（见 `AUDIT_BASELINE.md` §4）。
- 修复：手写 IPv6 展开（支持 `::`、IPv4 尾部、zone），按位判定 ULA/链路本地/站点本地/多播/文档/Teredo/6to4/IPv4-mapped/IPv4-compatible/NAT64，并复用 IPv4 私网判定。
- 回归：`tests/regression/vnext-fixes.test.ts`（修复前失败）。

### SEC-10（P0）宿主没有审批 hook 时 destructive 仍被放行
- 位置：`src/adapters/dsh/plugin.ts` + `src/security/permissions.ts`。
- 触发：宿主上下文没有 `ctx.on`（或 hook 注册失败），插件仍以 `hostApproval=true` 打开引擎。
- 影响：`system_maintenance(delete_chunk/restore/...)`、`knowledge_manage(invalidate/rollback)` 在没有任何用户审批的情况下执行。
- 证据：修复前探针在无 `ctx.on` 的 fake ctx 中成功删除 chunk。
- 修复：引擎先以 `hostApproval=false` 打开；只有 `tools/pre-execute` hook **注册成功** 后才 `enableHostApproval()`；注册抛错则保持本地确认流程。判定异常仍 fail-closed（返回 ask）。
- 回归：`tests/regression/vnext-fixes.test.ts`（无 hook → `APPROVAL_REQUIRED`，chunk 仍存在）。

### SEC-11（P1，数据完整性）JSON 对象数组被解码成对象
- 位置：`src/infrastructure/database/database.ts::decode`。
- 触发：任何 JSON 列的值是“对象数组”（如 `verification_evidence: [{...}]`、`tags` 中含 `{`）。
- 影响：读回 `{}` 而不是数组；核验证据、标签等结构被破坏，后续证据判断/质量分使用错误形状。写入的原始数据仍在库里，但读取路径失真。
- 证据：修复前 `Array.isArray(row.verification_evidence) === false`。
- 修复：先 `JSON.parse`，按解析后的实际类型返回；只有坏 JSON/null 才按列语义（数组列→[]，对象列→{}）退化。
- 回归：`tests/regression/vnext-fixes.test.ts`。

### SEC-12（P2，可靠性）HTTP 连接复用导致偶发 socket hang up
- 位置：`src/security/network.ts::requestOnce`。
- 触发：Node 全局 agent 默认 keep-alive；同一 host:port 的上一个服务关闭后，下一次抓取复用死 socket。
- 影响：同一 URL 在服务重启/短暂断开后偶发失败，错误为 `请求失败: socket hang up`，看起来像 SSRF/网络拒绝。
- 证据：本地 HTTP 测试在连续用例中稳定复现。
- 修复：抓取使用 `keepAlive:false` 的专用 Agent，并且每次请求仍把 DNS 结果钉死为 lookup。
- 回归：`tests/security/http-guard.test.ts`（6 条真实 HTTP 路径测试）。

## 2. 已验证的既有防护

| 防护 | 实现 | 测试 |
| --- | --- | --- |
| SSRF（IPv4） | 私网/环回/链路本地/元数据/保留地址拒绝 | network-approval.test |
| 端口限制 | 仅 80/443/8080/8443 | network-approval、http-guard |
| 重定向 | 逐跳重新校验，带循环检测与次数上限 | http-guard |
| DNS rebinding | 解析结果作为 `lookup` 钉死到实际连接 | network-approval（127.0.0.1 被拦） |
| 体积/超时 | 流式累计上限 + 总 deadline + socket timeout | http-guard |
| content-type | 前缀白名单，拒绝二进制 | http-guard |
| 路径穿越 | realpath 解析、符号链接逃逸拒绝 | network-approval |
| 密钥 | 写入前模式扫描、日志脱敏 | network-approval、prompt-injection |
| 审批令牌 | 24 字节随机、action+target 作用域、15 分钟、单次消费、用户侧批准 | network-approval、cli |
| 失败关闭 | hook 判定异常 → ask；无 hook → 本地确认 | vnext-fixes |
| 数据隔离 | 无项目作用域只返回 global；向量/倒排均按 allowedIds | knowledge.test（跨项目） |

## 3. 代码执行沙盒（strict 默认）

- 仅 **lab 模式**、仅 **JavaScript**；默认 `security.exec_sandbox="strict"`。
- 三层隔离：降权 `nobody(65534)` + `unshare -n` 网络命名空间 + Node `--permission`（只允许读写产物目录；未开启 child_process/worker/addons/inspector）。
- 超时杀整个进程组；输出截断；`--max-old-space-size`；产物目录软上限。
- 能力不足（缺少 unshare/setpriv 或 Node 不支持 Permission Model）时**失败关闭**，不会静默退回无隔离执行；`process` 必须显式配置，并在结果中标记 `process-only`。
- **边界**：不是 seccomp/LSM 内核沙箱，也不是容器；共享内核与文件系统视图，主要依赖运行时权限模型与 uid/命名空间。
- 证据：`tests/security/sandbox.test.ts` 9 项通过；逃逸探针中读 `/etc/passwd`、写 `/tmp`、`child_process`、网络全部被拒绝，产物目录内写入允许；超时 1s 内终止；2MB 产物超过 1MB 上限判失败。详见 `SANDBOX_IMPLEMENTATION.md`。

## 4. Prompt Injection / 不可信资料

- 当前没有模型调用路径；所有外部文本只进入抽取/存储，作为 `pending_verification` 数据。
- 注入语句不会被解释为指令；测试确认：注入文本被正常抽取、状态 unverified、不会触发删除/维护操作。
- 若未来恢复模型辅助：必须在系统提示中声明“资料是数据”，并对工具调用做同样的审批/预算约束；当前没有可被注入的模型通道。

## 5. 仍存在的风险（未修复，明确记录）

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 备份不含文档正文 | `data/documents/` 不在 DB 备份清单；只备份 DB 会导致正文丢失 | 备份整个 data 目录；或在清单中登记 documents 校验和 |
| 多进程并发写 | WAL + busy_timeout + BEGIN IMMEDIATE 降低冲突，但没有跨进程任务锁 | 同一 DB 只跑一个引擎；需要多实例时加文件锁/租约 |
| `allow_private_networks` | 显式开启后允许内网抓取（含 169.254） | 生产保持 false；开启时配合域名白名单 |
| 密钥扫描是启发式 | 正则无法覆盖全部格式 | 不把密钥作为知识内容；日志已脱敏 |
| 审计 detail 截断 | 大对象会截断/脱敏 | 需要完整取证时用数据库行 + 受控导出 |
| 沙盒不是内核级 | 见 §3 | 生产仍建议外层容器/cgroup；不要执行不可信代码 |
| MCP 双入口 | 默认关闭；同时开启可能并发写 | 二选一；MCP 只读/低频使用 |
| 根目录 `/` 作为 allowed_root | `PathPolicy` 的字符串前缀判断对 `/` 有边角问题 | 不要配置 `/` 为允许根（P3） |

## 6. 结论

本轮修复了 2 个高严重度绕过（IPv6 SSRF、无 hook 放行）与 1 个数据形状/1 个可靠性缺陷；其余既有防护有可执行测试。剩余风险主要是部署边界与“非沙箱”能力声明，已在文档中明确，不伪装为已解决。
