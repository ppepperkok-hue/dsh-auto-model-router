# dsh-auto-model-router

按任务的难易与复杂程度给 DSH 的每次请求选模型。插件从**当次真实请求**里取信号——指令长度、上下文规模、工具往返量、意图关键词——打成难度分，映射到四档，派给「干得完这份活的最便宜档」，档内按有序候选链降级，账号被限流或额度耗尽时自动换下一个。

插件同时提供两条互不依赖的路子：

- **虚拟 provider（`auto`）**——在模型选择器里选 `auto/auto`，每条请求都重新打分；选 `auto/<档位>` 则钉死某一档。因为它在注册表上就是一个普通 provider，主代理、子代理、workflow、teammate 全都能用。
- **`agent/request` 钩子**——宿主官方认可的每请求改写点（`dsh-agent-loop/lib/index.js:1143-1153`）。**对委派出去的 agent 默认开启**：子代理与 workflow 子任务会按难度被送到该去的档位。主代理不动，除非把 `agentScope` 调成 `all`，或者在模型选择器里直接选 `auto`。因为路由是在派发前定的，日志记的就是真正跑的那条。

## 四档

| 档位 | 适用 | 候选链示例 |
| --- | --- | --- |
| `tiny` | 格式化、提取、短查询 | `buddy/deepseek-v4-flash` → 免费车道 → `qodercn/qfmodel` |
| `standard` | 常规功能实现、单双文件改动 | `Step 5 Preview` → `buddy/deepseek-v4.1-flash` → `glm-5.3-flash` |
| `deep` | 跨文件重构、终端/CI 任务、长链智能体 | `buddy/glm-5.3` → `buddy/kimi-k3-1` → `zcode/GLM-5.3` |
| `max` | 开放式研究、整库改造、computer use | `buddy/glm-5.3` → 免费车道 `kimi-k3` → `workbuddy/gpt-6-astra` |

默认表是**实测出来的，不是猜的**：2026-10-12 对本机网关的探针（221 条路由、92 条应答）决定哪些候选真实存在，能力调研决定顺序。不可绕过的硬约束以 `CONSTRAINTS` 从 `./routes` 导出，`node scripts/plan.mjs --constraints` 可以打印。

## 安装

桌面端独占 `desktop` profile，命令行会被拒（`profile "desktop" is managed exclusively by the Electron application`）。按 profile bundle 的通用手工方式装：

1. 把本目录复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-auto-model-router`
2. 在该 profile 的 `dependencies` 里加 `"dsh-auto-model-router": "0.1.0"`
3. 在 `dsh.profile.bundles` 末尾追加 `"dsh-auto-model-router"`
4. **不要**再往 `cordis.patch.yml` 加行：本包自带 patch，两处注册会报 `duplicate loader entry id`
5. 重启应用

## 配置

两层，用户层覆盖组合层：

**1）插件设置页。** 插件会安装 `auto-model-router` 设置段，桌面端把它渲染在**设置 → 插件**里（内置的「子智能体」页就在同一处）。这里改的值**下一个请求就生效**，不用重启：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `agentScope` | `subagents` | `off` / `subagents` / `all` |
| `dryRun` | `false` | 只打分与记日志，不改路由 |
| `defaultTier` | `standard` | 打不出分时用的档 |
| `hysteresis` | `1` | 同一会话内可容忍的档位漂移 |
| `maxFallbacks` | `2` | 放弃前再多试几条候选 |
| `explain` | `true` | 把打分明细写进日志 |
| `thresholds` | `{2, 4.5, 8}` | 档位分界 |

**2）组合层（profile 的 `cordis.patch.yml`）**，作为基础层，也是部署端钉默认值的地方：

```yaml
- id: auto-model-router
  config:
    provider: auto            # 虚拟 provider id
    agentScope: subagents     # off | subagents | all
    defaultTier: standard
    thresholds: { standard: 2, deep: 4.5, max: 8 }
    tiers:                    # 省略即用实测默认表
      - id: standard
        name: Auto · Standard
        candidates:
          - { provider: buddy, model: deepseek-v4.1-flash }
          - { provider: our-free-model, model: stepfun/step-5-preview-free }
```

关键是 `agentScope`：

- `subagents`（默认）——每个被委派的子 agent 都按难度选模型，这就是「把任务包派给合适的模型」。
- `off`——什么都不改，只留一个虚拟 provider，要自己在模型选择器里选 `auto/...`。
- `all`——主代理也按每请求改写。

`dryRun: true` 保留打分与日志但不改路由，是观察路由器「本来会怎么选」的最省事办法。

档位表（`tiers`）在加载时固定：换候选链需要重载，而上面这些字段都是立即生效。

## 验证

```bash
node scripts/selftest.mjs        # 15 项：打分、档位、防抖、层内降级
node scripts/host-hook.test.mjs  #  8 项：agent/request 契约、作用域、释放
node scripts/settings.test.mjs   #  4 项：设置段安装、改设置即时生效
node scripts/integration.mjs     #  7 项：对着真实的 @deepseek-ai/dsh-llm 跑
node scripts/plan.mjs "把这段 JSON 格式化一下"
node scripts/plan.mjs --table
```

`settings.test.mjs` 与 `integration.mjs` 会 import `../index.js`，因此必须在**已装进 profile 的副本**里跑（那里才解析得到 `@deepseek-ai/schemastery`）；`selftest.mjs`、`host-hook.test.mjs`、`plan.mjs` 直接在源码目录就能跑。

`integration.mjs` 挂载宿主自己的 `LlmRuntime`（从已装 profile 解析路径），注册一个假上游加本插件，然后经 `provider: 'auto'` 流式请求。这是不重启应用所能做到的最接近真实 Host 的验证；它同时钉住了注册表真正会调的那些适配器方法——`providerInfo`、`providerRetryPolicy`、`imageRequestPricing`、`listModels`、`resolveModel`、`prepareCall`、`stream`（每一个都是踩出来的）。

## 已知限制

- **`llm/stream` 不是路由接缝**：主循环先 `prepareCall`，在那里改 provider/model 会抛 `INVALID_PREPARED_CALL`（`dsh-llm/lib/index.js:2166`、`:2241`），所以钩子只能挂 `agent/request`。
- **虚拟 provider 那条路会把用量记在 `auto/<档位>` 名下**，而不是真正服务的上游；`agent/request` 那条没有这个问题。
- 路由只在请求开始前决定，不会中途换；也不会改写已经 prepared 的调用。
- 会话内做 ±1 档的防抖，因为来回换 provider 会把 KV cache 复用打没。
