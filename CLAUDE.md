# Baton / Shikiri（仕切り）— AI Meeting Facilitator

> 英文品牌：**Baton**（代码、仓库、包名统一用 `baton`）
> 日文品牌：**Shikiri（仕切り）**（日本市场 UI 文案与营销用）

## 1. 产品定义

Baton 是一个加入 Zoom 会议的 AI facilitator（会议引导者）。它不是记录工具，而是**主动介入者**：

- 守住议程与时间（timebox 提醒、超时提示、推进下一步）
- 平衡发言权（airtime balance，识别长时间沉默的参会者）
- 逼出决策（识别"讨论很久但无人拍板"的状态）
- 守住结论（追踪 decision 与 action item，会末 recap）

**核心原则：引导而不接管。** Baton 只提示和推进，决定权始终在人。

### 两种模式（共用同一引擎）

| 模式 | 结构 | 介入强度 | 优先级 |
|---|---|---|---|
| Workshop mode（工作坊） | 强：预定义脚本（如 Design Sprint） | 高：按脚本规则推进 | **先做** |
| Meeting mode（日常会议） | 弱：日历邀请里的议程 | 低：以守结论为主 | 后做 |

### 第一阶段输出形态

**只在 Zoom App 侧边栏显示提示，不发语音、不往会议聊天框发消息。** 先验证提示内容有价值，再逐步升级输出渠道。

## 2. 技术栈

- **运行时**：Node.js（LTS）+ TypeScript，ESM
- **会议数据**：Zoom RTMS（Realtime Media Streams），官方 SDK `@zoom/rtms`
- **会议内 UI**：Zoom Apps（侧边栏），通过 Zoom Apps JS SDK 的 `startRTMS()` 或 auto-start 启动流
- **LLM**：通过 provider 抽象层调用，默认 Claude API；模型名放 `.env`，不要硬编码
- **测试**：Vitest
- **开发环境**：开发者使用 Windows，所有脚本必须跨平台（不要写只能在 bash 下跑的 npm scripts，路径用 `path.join`）

### 关于 RTMS API

RTMS 的具体接口**以官方文档和 sample apps 为准，不要凭记忆编写**。开工前先阅读：

- 官方文档：https://developers.zoom.us/docs/rtms/
- Quickstart：https://github.com/zoom/rtms-quickstart-js
- 最接近本项目的样例（会议内实时分析 agent + 侧边栏）：
  https://github.com/zoom/rtms-samples/tree/main/zoom_apps/ai_transcript_analysis_js

以该样例为脚手架参考，把"情绪分析"替换为"会议状态追踪 + 介入策略"。

## 3. 架构

```
Zoom Meeting
   │  RTMS (WebSocket: 分离后的转写 / 音频 / 参会者事件)
   ▼
[ingest]        ← 统一成 TranscriptEvent；真实 RTMS 与 replayer 走同一接口
   ▼
[state]         ← MeetingState：议程进度、发言时长、决策、待办、未决问题
   ▼
[policy]        ← 介入策略：规则优先，LLM 辅助判断
   ▼
[output]        ← Nudge 推送到 Zoom App 侧边栏
```

**关键设计约束：`ingest` 层必须抽象成一个 `TranscriptSource` 接口**，真实 RTMS 和离线回放器（replayer）是它的两个实现。下游代码不允许知道数据来自哪里。

### 目录结构

```
baton/
├─ CLAUDE.md
├─ src/
│  ├─ ingest/
│  │  ├─ types.ts            # TranscriptEvent, ParticipantEvent
│  │  ├─ source.ts           # TranscriptSource 接口
│  │  ├─ rtms-source.ts      # 真实 RTMS 实现
│  │  └─ replay-source.ts    # 回放实现
│  ├─ state/
│  │  ├─ meeting-state.ts
│  │  └─ tracker.ts          # 规则部分 + LLM 定期更新部分
│  ├─ policy/
│  │  ├─ rules/              # 每条介入规则一个文件
│  │  └─ engine.ts           # 冷却、优先级、限频
│  ├─ workshop/
│  │  ├─ schema.ts           # 工作坊脚本 schema（zod）
│  │  └─ runner.ts
│  ├─ llm/
│  │  └─ provider.ts
│  ├─ output/
│  │  └─ sidebar-channel.ts
│  └─ server.ts              # webhook + WebSocket 到侧边栏
├─ app/                      # Zoom App 侧边栏前端
├─ scripts/
│  └─ replay.ts              # CLI：回放一份转写并打印 nudge 时间线
├─ fixtures/
│  ├─ transcripts/           # 录制或合成的会议转写
│  └─ workshops/             # 工作坊脚本示例
└─ tests/
```

## 4. 核心数据结构

### TranscriptEvent

```ts
interface TranscriptEvent {
  meetingId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  startMs: number;   // 相对会议开始
  endMs: number;
  lang?: 'ja' | 'zh' | 'en' | 'mixed';
}
```

### 工作坊脚本（Workshop Script）

```ts
interface WorkshopScript {
  id: string;
  title: string;
  locale: 'ja' | 'zh' | 'en';
  steps: WorkshopStep[];
}

interface WorkshopStep {
  id: string;
  name: string;                 // e.g. "How Might We"
  timeboxMin: number;
  goal: string;                 // 这一步要达成什么
  expectedOutput?: {
    description: string;        // e.g. "每人至少 3 条 HMW"
    perParticipant?: number;
  };
  transition: 'on_timebox' | 'on_output' | 'either' | 'manual';
  warnAtRemainingMin?: number[]; // e.g. [3, 1]
  facilitatorScript?: string;    // 进入此步时侧边栏显示的引导语
}
```

用 zod 定义并校验。`fixtures/workshops/` 下至少提供一份完整的 Design Sprint 示例脚本。

### MeetingState

```ts
interface MeetingState {
  meetingId: string;
  mode: 'workshop' | 'meeting';
  elapsedMs: number;
  currentStepId?: string;
  stepStartedAtMs?: number;
  airtime: Record<string, { totalMs: number; lastSpokeAtMs: number }>;
  decisions: { text: string; atMs: number }[];
  actionItems: { text: string; owner?: string; atMs: number }[];
  openQuestions: { text: string; atMs: number }[];
}
```

### Nudge（介入输出）

```ts
interface Nudge {
  id: string;
  atMs: number;
  type: 'timebox' | 'step_transition' | 'silent_participant'
      | 'missing_decision' | 'missing_owner' | 'recap';
  priority: 1 | 2 | 3;          // 1 最高
  message: string;              // 面向人类主持人的提示
  ruleId: string;
}
```

## 5. 介入策略（policy）原则

1. **规则优先，LLM 辅助。** 计时、发言时长这类可确定判断的，一律用确定性规则；只有"是否已达成决策""是否偏题"这类语义判断才调用 LLM。
2. **冷却（cooldown）**：同一类型 nudge 有最短间隔（默认 3 分钟），可配置。
3. **限频**：全局每 5 分钟最多 2 条 nudge，超出的按优先级丢弃。宁可漏提示，不可刷屏。
4. **LLM 调用节流**：state tracker 的 LLM 更新按固定窗口（默认每 60 秒或每 N 条发言）批量进行，不逐句调用。
5. **可解释**：每条 nudge 必须带 `ruleId`，回放日志里能追溯为什么触发。

## 6. 分阶段任务

### Phase 0 — 回放器与基础设施（最优先）

- [x] 项目初始化：TypeScript、Vitest、ESLint、`.env.example`
- [x] `TranscriptSource` 接口 + `ReplaySource`（按原始时间戳节奏回放，支持 `--speed 10x` 加速）
- [x] 转写 fixture 格式定义；提供 2 份合成转写（一场工作坊、一场日常会议），覆盖：超时、长时间沉默、无结论讨论、有待办但无负责人
- [x] `scripts/replay.ts`：回放 fixture，输出 nudge 时间线

**验收**：`npm run replay -- fixtures/transcripts/<file>` 能跑完并打印时间线。

### Phase 1 — Workshop mode 引擎

- [x] 工作坊脚本 schema + Design Sprint 示例
- [x] workshop runner：步骤推进、timebox 提醒
- [x] 规则：`timebox_warning`、`timebox_exceeded`、`step_transition`、`silent_participant`
- [x] policy engine：冷却、限频、优先级
- [x] 每条规则都有基于回放 fixture 的测试，断言"在第 X 分钟附近触发 / 不触发"

**验收**：工作坊 fixture 回放时，nudge 时间线符合预期，且无刷屏。

### Phase 2 — LLM 状态追踪

- [ ] LLM provider 抽象 + Claude 实现
- [ ] tracker 定期抽取 decisions / actionItems / openQuestions
- [ ] 规则：`missing_decision`、`missing_owner`、会末 `recap`
- [ ] LLM 调用可 mock，测试不依赖网络

### Phase 3 — Zoom 接入

- [ ] 基于官方样例实现 `RtmsSource`
- [ ] Zoom App 侧边栏：当前步骤、倒计时、nudge 列表
- [ ] server：webhook 接收 + 推送 nudge 到侧边栏

**验收**：在真实 Zoom 会议中，侧边栏实时显示 nudge（需人工验收）。

### Phase 4 — Meeting mode

- [ ] 从日历邀请文本解析议程
- [ ] 低强度规则集：以守结论为主

## 7. 需要人类完成的事项（Claude Code 不要尝试代劳）

- 在 Zoom App Marketplace 创建 app，配置 scope、webhook 订阅、RTMS 功能
- 获取 client ID / secret，填入本地 `.env`
- 购买 RTMS credits
- 提供公网 HTTPS 端点（ngrok 或云部署）
- 录制真实会议转写并放入 `fixtures/transcripts/`（注意征得参会者同意、去除敏感信息）
- 真实会议中的体验验收

遇到需要以上事项才能继续的地方，停下来说明缺什么，然后继续做不依赖它的部分。

## 8. 硬性约束

- **绝不提交凭证**：所有 secret 只来自环境变量；`.env` 必须在 `.gitignore` 中
- **不要凭记忆写 Zoom API**：不确定的接口先查官方文档和样例
- **多语言**：转写可能是中日英混说；nudge 文案按 `locale` 输出，不要假设单一语言
- **隐私**：日志中不写入完整转写原文，只保留 nudge 与 ruleId；fixture 中不放真实个人信息
- **每个 Phase 结束时**：运行全部测试，更新本文件中的任务勾选状态

## 9. 待验证的关键假设

1. Zoom 自带转写对中日英混说的识别质量是否够用；不够则改为通过 RTMS 获取原始音频，自行接入 ASR
2. 侧边栏提示的时机与语气是否被参会者接受
3. 单场会议的 RTMS + LLM 成本是否在可接受范围
