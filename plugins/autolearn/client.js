/**
 * 自主学习插件的设置卡（Client 半边）。
 *
 * 注册进 `plugins.bundle.config`（key = 插件包名），在「设置 → 插件 →
 * 自主学习」的 bundle 页上渲染。数据来自 Host 路由 `/dsh-autolearn/api/settings`，
 * 与 Python 引擎读同一份 `data/settings.json`。
 *
 * 只用 react 与主题 token，不依赖 Harness 的 Client 基础组件包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-autolearn',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PACKAGE_NAME = '@local/dsh-autolearn'
    const API = '/dsh-autolearn/api/settings'

    const MODE_OPTIONS = [
      { value: 'assisted', label: '辅助（assisted）', hint: '高风险操作需要你审批' },
      { value: 'auto', label: '自动（auto）', hint: '在授权范围内自动提取与核验' },
      { value: 'lab', label: '实验（lab）', hint: '允许在 strict 沙盒中执行 JavaScript' },
    ]

    const token = (name, fallback) => `var(${name}, ${fallback})`
    const COLORS = {
      label: token('--dsw-alias-label-primary', 'inherit'),
      secondary: token('--dsw-alias-label-secondary', 'rgba(127,127,127,0.9)'),
      border: token('--dsw-alias-border-l2', 'rgba(127,127,127,0.25)'),
      surface: token('--dsw-alias-bg-layer-1', 'rgba(127,127,127,0.06)'),
      field: token('--dsw-alias-bg-layer-2', 'rgba(127,127,127,0.10)'),
      accent: token('--dsw-alias-brand-primary', '#4a7cf0'),
      danger: token('--dsw-alias-label-danger', '#d9534f'),
      success: token('--dsw-alias-label-success', '#2e9e5b'),
    }

    const fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: `1px solid ${COLORS.border}`,
      background: COLORS.field,
      color: COLORS.label,
      fontSize: 13,
      fontFamily: 'inherit',
    }

    function Row(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: COLORS.label } }, props.label),
        props.control,
        props.hint
          ? h('div', { style: { fontSize: 12, lineHeight: 1.5, color: COLORS.secondary } }, props.hint)
          : null,
      )
    }

    function ConfigCard() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [draft, setDraft] = React.useState({ mode: 'assisted', dataDir: '', dailyBudgetUsd: 1, maxTasksPerRun: 30 })
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')

      const load = React.useCallback(() => {
        setState({ phase: 'loading' })
        fetch(API)
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            setDraft({
              mode: data.settings.mode,
              dataDir: data.settings.dataDir || '',
              dailyBudgetUsd: data.settings.dailyBudgetUsd,
              maxTasksPerRun: data.settings.maxTasksPerRun,
            })
            setState({ phase: 'ready', data })
            setMessage('')
          })
          .catch((error) => setState({ phase: 'error', error: String(error && error.message ? error.message : error) }))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const save = React.useCallback(() => {
        setSaving(true)
        setMessage('')
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        })
          .then(async (response) => {
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
            setState({ phase: 'ready', data: { ...(state.data || {}), ...data } })
            setMessage('已保存，下一轮学习开始时生效')
          })
          .catch((error) => setMessage(`保存失败：${error && error.message ? error.message : error}`))
          .finally(() => setSaving(false))
      }, [draft, state.data])

      const resetDefaults = React.useCallback(() => {
        const defaults = (state.data && state.data.defaults) || { mode: 'assisted', dataDir: '', dailyBudgetUsd: 1, maxTasksPerRun: 30 }
        setDraft({ mode: defaults.mode, dataDir: '', dailyBudgetUsd: defaults.dailyBudgetUsd, maxTasksPerRun: defaults.maxTasksPerRun })
        setMessage('已恢复默认值，点击保存后生效')
      }, [state.data])

      if (state.phase === 'loading') {
        return h('div', { style: { padding: 16, fontSize: 13, color: COLORS.secondary } }, '正在读取配置…')
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { style: { padding: 16, fontSize: 13, color: COLORS.danger } },
          `设置接口不可用：${state.error}。请确认插件已启用，并重启 DSH 让新模块生效。`,
        )
      }

      const effectiveDataDir =
        state.data && state.data.effectiveDataDir ? state.data.effectiveDataDir : state.data?.effectiveDataDir || ''
      const notes = (state.data && state.data.notes) || {}
      const security = state.data && state.data.security

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 20px 20px',
            margin: '4px 0 8px',
            borderRadius: 12,
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.label,
          },
        },
        h(
          'div',
          { style: { marginBottom: 4, fontSize: 14, fontWeight: 600 } },
          '自主学习 · 配置与安全',
        ),
        h(
          'div',
          { style: { marginBottom: 18, fontSize: 12, lineHeight: 1.6, color: COLORS.secondary } },
          '这些值保存在引擎目录的 data/settings.json，与 TypeScript 学习引擎共用；安全边界来自 config.json，只读展示，不会改变 DSH 的全局权限设置。',
        ),

        h(
          Row,
          { label: '运行模式', hint: (MODE_OPTIONS.find((m) => m.value === draft.mode) || {}).hint },
          h(
            'select',
            {
              value: draft.mode,
              onChange: (event) => setDraft({ ...draft, mode: event.target.value }),
              style: fieldStyle,
            },
            MODE_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        ),

        h(
          Row,
          {
            label: '数据目录',
            hint: `留空使用默认目录：${effectiveDataDir || 'data/'}。${notes.reconnect || '数据目录变更后需重启 DSH。'}`,
          },
          h('input', {
            type: 'text',
            value: draft.dataDir,
            placeholder: effectiveDataDir,
            spellCheck: false,
            onChange: (event) => setDraft({ ...draft, dataDir: event.target.value }),
            style: { ...fieldStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          }),
        ),

        h(
          Row,
          {
            label: '每日预算（USD，估算值）',
            hint: `${notes.live || '下一轮学习开始时生效'}；0 表示不做费用上限（仍受调用次数限制）。`,
          },
          h('input', {
            type: 'number',
            min: 0,
            max: 1000,
            step: 0.1,
            value: draft.dailyBudgetUsd,
            onChange: (event) => setDraft({ ...draft, dailyBudgetUsd: Number(event.target.value) }),
            style: { ...fieldStyle, maxWidth: 180 },
          }),
        ),

        h(
          Row,
          {
            label: '每轮任务上限',
            hint: '1–200；与每日预算一起在下一轮学习开始时生效。',
          },
          h('input', {
            type: 'number',
            min: 1,
            max: 200,
            step: 1,
            value: draft.maxTasksPerRun,
            onChange: (event) => setDraft({ ...draft, maxTasksPerRun: Number(event.target.value) }),
            style: { ...fieldStyle, maxWidth: 180 },
          }),
        ),

        h('div', { style: { marginTop: 8, marginBottom: 6, fontSize: 13, fontWeight: 600, color: COLORS.label } }, '运行与安全（只读）'),
        security
          ? h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 8 } },
              ...[
                ['网络访问', security.allow_network ? '允许（受白名单约束）' : '关闭'],
                ['私有网络', security.allow_private_networks ? '允许' : '禁止'],
                ['代码执行沙盒', security.exec_sandbox === 'strict' ? 'strict（降权 + netns + 权限模型）' : 'process（无沙盒，显式）'],
                ['执行限制', `${security.exec_timeout_s}s / ${security.exec_memory_mb}MB / 产物 ${security.exec_artifact_mb}MB`],
                ['审计日志', security.audit_log ? '开启' : '关闭'],
                ['密钥扫描', security.block_secret_patterns ? '开启' : '关闭'],
              ].map(([key, value]) =>
                h(
                  'div',
                  { key, style: { padding: '8px 10px', borderRadius: 8, background: COLORS.field, border: `1px solid ${COLORS.border}` } },
                  h('div', { style: { fontSize: 11, color: COLORS.secondary } }, key),
                  h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 2, color: COLORS.label } }, value),
                ),
              ),
            )
          : h('div', { style: { fontSize: 12, color: COLORS.secondary, marginBottom: 8 } }, '未读取到 config.json 的 security 段（引擎目录未定位）。'),
        h('div', { style: { fontSize: 11, lineHeight: 1.6, color: COLORS.secondary, marginBottom: 12 } }, (state.data && state.data.boundary) || ''),
        h('div', { style: { fontSize: 11, color: COLORS.secondary, marginBottom: 12 } }, (notes.security || '安全边界由 config.json 控制；修改后需重启 DSH。')),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: saving,
              style: {
                padding: '8px 18px',
                borderRadius: 8,
                border: 'none',
                background: COLORS.accent,
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.7 : 1,
              },
            },
            saving ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: resetDefaults,
              disabled: saving,
              style: {
                padding: '8px 14px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: 'transparent',
                color: COLORS.secondary,
                fontSize: 13,
                cursor: saving ? 'default' : 'pointer',
              },
            },
            '恢复默认',
          ),
          message
            ? h(
                'span',
                {
                  style: {
                    fontSize: 12,
                    color: message.startsWith('保存失败') ? COLORS.danger : COLORS.success,
                  },
                },
                message,
              )
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', function* () {
          yield ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, ConfigCard)
        })
      },
    }
  },
})
