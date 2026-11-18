# HFC 定制分支维护指南

## 范围与基线

本指南面向 `sthnow/dsh-im` 的 `hfc-maintenance` 分支。上游基线为 dsh-im **v5.10.0**，提交 `c826bfa415d79669d8ebba206cf4a1eac554d8e2`；整理来源为已选定的 `5.10.0-hermes-hfc.11` 隔离候选。维护分支保留上游维护资产，不把发布包目录中未包含的文件视为删除意图，也不混入旧工作树的未合并实验。

**此次 Git 整理重新执行了构建及相关回归，未重新运行完整产品回归或真实客户端验收。** 本轮与候选阶段的历史证据分开记录，不代表当前运行插件已经安装或升级。分支整理、远端推送、构建打包、安装和真实 Host 激活是不同步骤；本指南不授予任何额外操作权限。

旧的 `hermes_card` 是独立的 **legacy Hermes-inspired** 渲染模式，参见 [旧模式说明](hermes-card-mode.md)。它不是这里的固定版 HFC Python 后端；选择旧 UI 模式不等于启用 HFC。

## 补丁分层与关键入口

| 层 | 职责和维护入口 |
| --- | --- |
| 原有展示及事件适配 | [legacy 卡片](../src/channels/feishu/hermes-card.mjs)、[过程跟踪](../src/channels/feishu/hermes-progress.mjs)、[共享 Harness 接入](../src/channels/shared/harness-client.mjs)；保留旧模式和默认行为 |
| HFC 展示边界 | [适配器](../src/channels/feishu/hfc/adapter.mjs)、[worker 客户端](../src/channels/feishu/hfc/worker-client.mjs)、[Python worker](../assets/hfc/worker.py)、[边界 README](../src/channels/feishu/hfc/README.md) |
| 配置、运行时和权限链 | [per-bot 配置归一化](../src/channels/feishu/hfc-presentation-config.mjs)、[运行时](../src/channels/feishu/feishu-runtime.mjs)、[飞书 bridge](../src/channels/feishu/bridge.mjs)、[生产装配](../plugin-src/host/channels/feishu/production.mjs) |
| 共享平台兼容和指标 | [共享渠道目录](../src/channels/shared/)；共享事件、取消、交付及指标改动可能影响其他渠道，不能只跑 HFC 用例 |
| 状态一致性和删除屏障 | [状态存储](../src/channels/feishu/state-store.mjs)、[状态协调](../src/channels/feishu/state-coordination.mjs)及生产 factory/controller 生命周期 |
| 回归和维护证据 | [飞书测试](../test/channels/feishu/)、[共享测试](../test/channels/shared/)、[Host 测试入口](../test/host.test.mjs)、本指南及旧模式说明 |

这是职责分层，不声称每层恰好对应一个提交。实际提交应按差异块审查，明确共享模块和跨渠道修改。文档链接以仓库源码为准，不依赖维护者私人目录中的报告或备份。

## 运行前提：检查实际 Host，不只检查工具 Node

- 包声明 Node `>=22.19`，但版本范围**不是**目标 Host 具备 `node:sqlite` 的证明。飞书状态层实际需要 `DatabaseSync`；不可用时抛出 `FEISHU_STATE_SQLITE_UNAVAILABLE`，不要删除协调协议或退回无锁写入来绕过。
- Python **3.10+，仅标准库**。通过每个机器人配置显式提供可执行文件；不依赖 PATH 自动发现、全局 Python 包、HFC 服务或 HFC 用户配置。
- 每轮一个 `HfcWorker`，以 `-I -S -B` 启动，使用最小、无机器人凭据的环境和有界 JSONL。协议、生命周期或预算硬错误会 poison worker；同轮不自动重启。源码和 bundle 均须能找到打包的 worker 及 vendor 资源。
- 历史候选阶段用**实际 Desktop Host 的同一可执行文件**启动独立诊断进程，验证了 `DatabaseSync`、内存事务及真实候选 StateStore（共享 core、mirror 身份、SHA-CAS 和持久退休）。当时环境为 Node **24.21.0**、Electron **44.7.0**、SQLite **3.53.4**。这不是工具 Node 替代证据，也不是原 Host PID 内动态执行或新版插件激活验收。
- 换机器、换 Host 构建或升级 DSH 后要重新补证；实际安装后的模块加载和权限集成仍须另验。不要为测试擅自改变运行配置或安装诊断插件。

## 显式、逐机器人灰度

`hfcPresentation` 属于单个机器人。缺省或未知 `backend` 为 `legacy`；只有 `backend: "hfc"` 且当前绑定的 DSH session 在 `testSessionIds` 中才走 HFC。白名单去重后最多 **32** 项，只接受长度 1–256、无首尾空白的字符串；不自动迁移旧配置，不以环境变量全局开启。会话重绑后必须重新匹配，不能在绑定变化时提交第二次 ask 或静默另走旧链。

下面是**合成配置片段模板，不是完整配置，也不是任何部署的实际值**。把它放入经授权配置的单个 bot 条目时，再由操作者填入自己验证过的值；不要将实际配置、账号、凭据或会话标识提交到仓库。

```json
{
  "hfcPresentation": {
    "backend": "hfc",
    "testSessionIds": ["<DSH_SESSION_ID>"],
    "python": "<ABSOLUTE_PYTHON_EXECUTABLE>"
  }
}
```

生产 `createRuntime` 每次生成新的 UUID v4 `runtimeNamespace`，只用于展示路由隔离，**不是 Host profile，不是凭据，也不是授权证明**。HFC 事件中沿用的 `data.profile_id` 承载这个运行时 namespace，不能把它解释为用户的 DSH profile。可信路由包含 `runtimeNamespace / botId / sessionId / chatId / senderId / turnId`；按钮中的值必须与可信传输参与者及当前交互消息绑定一起核验。

## 正文、交互和投递契约

1. HFC **schema 2.0 正文卡**与 **schema 1.0 独立交互 rail** 分离。单选、多选、自定义输入及审批控件不塞回正文卡；只有明确发送回执确认了独立交互消息的非空 `message_id` 后，才绑定当前 token、表单名及回调权限。
2. 卡片和 worker 的 `accepted` 只是展示协议结果，**不是执行成功、审批授权或业务完成**。执行仍走 DSH 原有 approval queue / question respond closure。成功消费 RPC 必须先提交，再做显示 I/O；旧卡片不能因更新失败而重新执行。
3. 回执缺 ID、partial、unknown、failed、cancelled、不完整分块都不能视为成功。**unknown 不自动 retry**；patch 失败不得伪装成新 create，也不得同时由旧链重复发送。已开始的网络请求不能被取消信号倒转。
4. renderer/预算失败而尚无投递不确定性时，可由**同一 owner** 将完整 DSH 最终文本交给 native sink；投递失败或 unknown 后不能再自动重发。每轮只有一次终态尝试。HFC v5.0.25 的空 `primary_text` 不是完整答案来源。
5. 支持 `card`、`deferred_native` 和终态 `native`；deferred 只更新占位，不提前发原生正文；`segmented` 明确拒绝，不静默丢弃续卡。长文可能经 native 完整文本或文本附件回传，应同时核验正文和附件。
6. 草稿合并、单飞发布、PATCH 间隔、队列、重放、输入输出及交互条目均有界；交互及终态需要强 flush/barrier。不要把吞吐优化改成跳过终态或绕过 receipt gate。
7. 耗时、token、上下文与速率只显示可归属的可信来源；墙钟耗时含等待，不是解码时间，不以字符数或整轮耗时伪造 tok/s。完成一轮不等于 Goal、子代理或后台 job 全部完成。

## 状态协议：不是全系统线性一致性

同一进程、同一物理路径共享 core、状态对象和写队列（包括重复 ESM 实例）。JSON 使用随机独占临时文件加 rename 提交，不再共用固定 `.tmp`。合作的新版本进程在短 SQLite 排他事务内核对 JSON 实际字节 SHA；不是跨进程自动合并。

| 情况 | 含义和处理边界 |
| --- | --- |
| `FEISHU_STATE_LOCKED` | SQLite 锁竞争；本次操作失败，可在锁释放后由调用者重试。不得凭 PID/TTL 抢锁；进程退出由 SQLite/OS 释放锁 |
| `FEISHU_STATE_CONFLICT` | 持久字节与加载基线不符，陈旧 core 已 poison；**关闭该 core 的全部本地 handle 后重开**并重新读取。对同一 poisoned handle 重复 load 不能清毒，不盲目 flush 陈旧缓存 |
| `FEISHU_STATE_RETIRED` | 路径已进入退休/删除屏障；不能以同路径、同 ID 自动重建复活 |
| `FEISHU_STATE_UNSAFE_PATH` | 文件 symlink/hardlink 等别名或检测到父路径变化被保守拒绝；不通过改别名绕过检查 |

getter 是**缓存读，不是跨进程线性一致读**；保证的是陈旧持久写明确拒绝。同进程 mirror 替换在持久化 Promise 完成前仍保持同步可见的对象身份契约。关闭一个 handle 不会关闭其他活跃 handle。

删除先同步撤销本地 core 新操作、排空已授权写，再提交 `${statePath}.coord.sqlite` 内持久退休墓碑，最后 unlink JSON。跨进程持久撤权在 retire 提交时生效；如果凭据删除失败且未走到 retire，不能声称其他进程已永久撤权。factory close 的异常路径也必须释放状态/退休句柄。

**协调数据库不是可丢弃缓存。不可单删、单独回滚或换路径以绕过墓碑。** 备份、迁移、回退要先停掉全部写者，以一致时间点一起考虑 JSON 与协调数据库；若 SQLite 尚有日志文件，也要按一致性备份方式处理。旧版本不认识协议，**新旧版本不能并发写同一状态**；仅回退包不等于状态回滚安全。永久墓碑不提供代际重开功能，不支持随意“清状态重建”。

明确不保证：config/workspace 的跨进程事务、facade-specific 会话绑定 RMW 全局串行、旧版本或恶意外部写者合作、所有 Windows 特殊别名及恶意目录替换。父目录 realpath、Windows 大小写/junction 有历史测试；文件 symlink/hardlink 保守拒绝。测试中的进程 kill **不是掉电测试**；没有 fsync/系统断电持久性承诺，未提交随机 tmp 不自动恢复。

## 固定 vendor 与许可证

[MANIFEST.json](../assets/hfc/upstream/MANIFEST.json) 固定 HFC **v5.0.25** 的 `render/session/events` 相对导入闭包：**23 个 Python 模块 + MIT LICENSE = 24 个 SHA-256 项**；加 manifest 本身，目录共有 25 个文件。[许可证](../assets/hfc/upstream/LICENSE)必须随包保留。没有引入 HFC server、网络客户端、配置加载器或执行 registry。

维护者应保留上游模块未修改的边界，将 DSH 适配留在 worker/adapter。清单自洽、与本地来源比对、联网核验固定上游来源是不同证据；没有做的不能写成已做。不得启动时自动拉最新、静默安装 Python 依赖或自动替换 vendor。

## 历史验证记录：保留失败和未验收项

本次维护分支使用 Node 24.21.0、Python 3.12.14、文件并发数 2、单文件超时 60000ms，执行了 66 个相关测试文件：首次 **1490 总数：1484 pass、1 fail、5 skip**。唯一失败是测试把资源目录名写死为 `candidate`；改为相对测试文件定位并精确比较 worker 路径后，同范围复验为 **1490 总数：1485 pass、0 fail、5 skip**。保留显式 Python 配置拒绝断言，未修改生产资源定位。client、host、verify-package 三项构建均 exit 0。本次未重新运行完整产品回归或真实飞书验收，也未修改正在运行的插件。

维护分支新增本指南的打包入口并重建两个 lib；包元数据嵌入、源码换行规范化及构建路径标注等会改变产物字节，**不把新 lib 声称为原候选 lib 的字节复制**。

以下为候选阶段的历史记录，不以本次相关复验覆盖其失败。历史主回归同样使用 Node 24.21.0、Python 3.12.14、文件并发数 2，相关及全量入口单文件超时 60000ms。

| 层级 | 历史结果与边界 |
| --- | --- |
| 飞书及相关 shared/Host | **1602 总数：1597 pass、0 fail、5 skip** |
| 完整产品回归 | **5363 总数：5355 pass、2 fail、6 skip，exit 1**，不是全绿 |
| 原失败文件不改代码复验 | **20 总数：19 pass、1 fail，exit 1**；原两失败用例复验通过，但 QQ 菜单另一用例失败，不能用复验覆盖首败 |
| 独立状态安全验证 | 13/13 断言；26 个真实 Node 子进程 close，无 watchdog timeout；另有 8 项确定性设计探针。kill 不是掉电保证 |
| 历史构建和包冒烟 | client、host、verify-package exit 0；真实 Python 问答及实际归档解包后源码重 bundle 冒烟通过。这不是原始 Host lib 激活 |
| 真实飞书样本 | 普通回复、问答、长文文本附件、stop 样本通过；不代表全部设备/异常场景。**真实执行审批处于 disabled，未验收**，不得写成审批已通过 |

完整回归首败为 [QQ 菜单测试](../test/channels/qq/menu.test.mjs) workspace/new session/compact/stop/steer 组合的 steer 调用缺失，以及 [队列持久化测试](../test/queued-message-durability.test.mjs) QQ submitted 队列记录未清空。复验时另一 QQ 菜单用例出现 `Cannot read properties of undefined (reading 'text')`。根因未确定、未根治，没有为分支整理扩大 QQ 修复范围。

2026-11-16 的普通文本流式/完成态截图属于旧 legacy Hermes-inspired 阶段，只能作为旧模式历史背景，不能计为本轮 HFC 或状态修复验收。离线测试、归档一致性、同 exe 独立探针、运行端激活与真实聊天验收须分别报告。

## 后续升级和交付流程（待执行操作，不是本轮已执行记录）

1. **记录当前状态和授权边界。** 确认干净工作树、实际维护分支、明确 upstream 基线和目标版本；先审查 release notes/依赖/许可证。候选包缺失上游文件不是删除理由。保留本地实验在原处。
2. **显式合并 upstream。** 获取指定上游版本并 merge 到维护分支；按上述补丁层解决冲突，保留旧默认、per-bot 白名单、单 owner、receipt gate 和状态墓碑，不自动追随 latest，不自动提 PR。
3. **单独决定 HFC vendor 是否刷新。** dsh-im 升级不等于 HFC 升级。若确需刷新，明确固定 tag/commit，重新求导入闭包、检查 23 模块假设是否变化、逐项 SHA-256、LICENSE 和 notices，并记录来源；不要只改版本字符串或 manifest。重新审查配置默认与协议变化。
4. **显式回归。** 安装经审查的项目依赖；运行针对 HFC/问答/审批拒绝路径/取消/重绑定/unknown/状态协调/生产生命周期的回归，再跑全量。真实 Python 用例必须显式提供 `DSH_HFC_TEST_PYTHON`，缺省会 skip，不能据此宣称 Python 后端已验收。

   POSIX shell 模板（替换占位路径，不是已执行命令）：
   ```sh
   DSH_HFC_TEST_PYTHON="<ABSOLUTE_PYTHON_EXECUTABLE>" node --test test/channels/feishu/hfc-adapter.test.mjs
   DSH_HFC_TEST_PYTHON="<ABSOLUTE_PYTHON_EXECUTABLE>" npm test
   npm run build
   node scripts/verify-package.mjs
   npm pack
   ```
   其他 shell 按其环境变量语法设置。`npm run build` 构建 client 和 host；缺少资源、依赖或测试跳过都要明示，保留首败和局部复验，不以局部通过替代全量。
5. **验证实际包。** 检查归档成员、资源定位、vendor 清单/hash/license；确认 worker 和全部闭包均在包内，并在解包环境进行真实 Python、Node SQLite 和集成冒烟。源码重 bundle 探针必须注明该变换，不能称为原包入口激活。
6. **单独授权后安装。** 协调停写，备份状态和配置且不公开凭据；取得安装/重载授权，再按插件管理器实际 nextStep 操作，核对真正运行的 Host、版本及资源。以少量白名单会话灰度，分别验普通/问答/长文附件/stop/真实审批；审批 disabled 时仅标未验收，不伪造审批、不擅自扩大执行权限。
7. **回退也需一致性计划。** 先停全部新旧写者，检查 JSON 与协调数据库的配套备份和退休状态；不可只回滚协调文件或删除墓碑。切回展示 backend 与回退代码/状态是不同操作。报告安装、端到端及遗留问题状态，不自动 push、发 PR 或修改运行配置。
