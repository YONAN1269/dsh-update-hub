# dsh-update-hub

批量更新 DSH 插件，并且能自动更新。左侧栏有一个图标，右上角的数字就是待更新数量；点开是完整面板，有列表、进度、单条更新和一整套自动化设置。

## 它解决的是哪两个问题

**1. 商店里装不上正在用的插件。**
商店的更新流程是「先移除旧包、再装新包」，桌面端不允许移除正在运行的插件，于是返回 `bundle-in-use`：

```
这个插件正在使用中，桌面端不允许现在移除
```

本机日志（`~/.dsh/profiles/desktop/.dsh-market/log.ndjson`）里这个错误累计出现 83 次，覆盖 13 个以上插件。本插件走另一条路：`pnpm add <包名>@<精确版本> --save-exact`，只用安装侧、不做移除，所以在跑的插件也能装上。

**2. 更新完还反复提示「有新版本」。**
插件自更新只把文件写进 `node_modules`，不改进 `profile` 清单，于是清单永远落后于磁盘：

```
dsh-bottom-info-bar   清单 1.23.0 / 实装 1.24.3
```

本插件比对时读的是 **磁盘上的实装版本**，不是清单里的声明；`--save-exact` 会在同一步把清单一起推进。清单与磁盘不一致的插件会多出一个「对齐」按钮，点一下就把声明写成磁盘上的真实版本。

## 界面

| 位置 | 作用 |
|---|---|
| 左侧栏（`sidebar.panellist`） | 常驻图标，有更新时右上角显示数字角标；安装中右下角有脉动小点 |
| 主区域（`main`） | 点图标打开的完整页面 |
| 插件详情页（`plugins.bundle.config`） | 同一个面板，摘要行显示「N 个插件待更新」 |

面板结构：

```
插件更新                                    2 个待更新 · 共 45 个 · 上次检查 17:33
                                          [全部更新] [重新检查] [重建界面]
──────────────────────────────────────────────────────────────────────
● dsh-better-sidebar                       0.32.0 → 0.32.1        [更新]
● @michengai/dsh-btw                        1.3.8 → 1.3.10        [更新]
● @linxin666/…                    清单 1.0.0 / 磁盘 1.0.3         [对齐]
──────────────────────────────────────────────────────────────────────
自动化
启动时检测                                          每次打开 DSH 查一次    [开|关]
定时检测                                                      下次 18:33  [关|6 小时|12 小时|24 小时]
空闲自动更新                                                                [关|10 分钟|30 分钟|1 小时|2 小时]
```

进度是 `2/5` 这种实数加一条按真实比例走的细条，不做会自己往前爬的假百分比——单个包 3–30 秒，假装中间过程没有意义。

## 自动化

三件事分得很清，因为它们的安全边界不同：

| 设置 | 默认 | 做什么 |
|---|---|---|
| 启动时检测 | 开 | 打开 DSH 后 15 秒查一次 registry。一小时内重启过就不重复查 |
| 定时检测 | 12 小时 | 在 DSH 开着的时候按间隔查。查失败有 10 分钟退避，不会每分钟重试 |
| 空闲自动更新 | **关** | 没有人用 DSH 时，把待更新项自动装掉 |
| 空闲更新后自动重建 | 开 | 装完自动刷新界面让新版本生效 |

**「空闲」的判据刻意保守。** 同时满足才算：

1. 宿主已运行超过 5 分钟（刚启动时分不清「没人」和「界面还没起来」）；
2. 收到过至少一次界面心跳（否则不知道有没有人）；
3. 超过你设的时长没有「可见且有人操作」的心跳；
4. **窗口当前不可见**——窗口在前台就一直不动，哪怕鼠标十分钟没动。

第 4 条是关键：正在输出的流式回答和「人走开了」在宿主看来完全一样，而只有后者能容忍 `node_modules` 被挪动。所以要让它在后台更新，就把窗口切走或最小化。

同理，自动重建界面只在窗口不可见时执行，绝不会把你正在看的内容刷掉。

## 为什么不做「自动重启应用」

`@noob-stupid/dsh-plugin-console` 的 `lib/server/domain/restart.js` 里记着一条结论，是 2026-10-10 排障留下的：

- 桌面端**没有**给插件用的重启通道（`preload-app.cjs` 的 IPC 全表里没有 restart/relaunch，宿主 ↔ 外壳只有 `update-tasks` / `quit-inspection` / `shutdown`）；
- 手动 kill 宿主再 spawn 一个，外壳会走 `fail()` → 弹「应用无法启动或已意外停止」；
- 独立 `dsh web` 再起一个会和宿主争端口，`EADDRINUSE`。

所以本插件**不 kill、不 spawn、不建计划任务**。自动更新做完之后：

- 客户端插件的新版本：自动重建界面即生效；
- 宿主端插件（改了 `lib/index.js` 那类）：下次启动 DSH 时生效，面板里不会假装它已经生效。

## 行为细节

- **一次只跑一个任务。** 有任务在跑时再点会被拒（`busy`），不排队——排队会让点击看起来成功了却几分钟没反应。
- **每条独立计成功/失败。** 一个包失败不影响后面的，失败原因取 pnpm 输出的最后一条有意义的行。
- **装完校验磁盘。** 退出码 0 不算成功，`node_modules/<包>/package.json` 的版本等于目标版本才算。
- **检查结果缓存 6 小时。** 「重新检查」绕过缓存；registry 报错时保留上一次的答案并标注，同时 3 分钟内不再重试同一个包。
- **超时 15 分钟**，超时终止整棵进程树。
- **不会拿清单当基准。** 比对永远读磁盘，否则就会复刻 `dsh-bottom-info-bar` 那种「永远提示有新版本」的循环。

## 安装

公开包：[npm `dsh-update-hub`](https://www.npmjs.com/package/dsh-update-hub) · 源码：[GitHub `YONAN1269/dsh-update-hub`](https://github.com/YONAN1269/dsh-update-hub) · MIT。

### 从 npm 装（推荐）

在 `~/.dsh/profiles/desktop` 下执行：

```sh
pnpm add dsh-update-hub
```

`cordis.patch.yml` 会把 bundle 注册进去；如果 `package.json` 的 `dsh.profile.bundles` 里没有出现 `dsh-update-hub`，手动补一行。**重启一次 DSH** 让它进入启动清单，之后改客户端代码只要按面板里的「重建界面」。

### 从本地源码装（开发用）

```sh
pnpm add "dsh-update-hub@link:<本目录>"
```

同样要确认 `dsh.profile.bundles` 里有这一行。link 方式改源码即时可见，适合调界面。

### 一键发布

Windows 下双击 `publish.bat`：菜单 `[1]` 生成本地安装包、`[3]` 发布到 npm、`[4]` 验证。要改包名或输出目录，用记事本编辑 `publish-config.txt`，不用碰 `.bat`。

## 开发

```sh
node --check lib/index.js && node --check lib/client.js
DSH_PROFILE_DIR="C:/Users/<你>/.dsh/profiles/desktop" node tests/offline.mjs
DSH_PROFILE_DIR="C:/Users/<你>/.dsh/profiles/desktop" node tests/render.mjs
```

- `tests/offline.mjs` 不装任何东西，只验证：profile 定位、pnpm 定位、版本比对、磁盘版本读取、registry 查询。
- `tests/render.mjs` 用极简 React 替身把客户端组件真渲染一遍，能抓出未定义引用、条件调用 hook、有真实数据时抛错这类问题。

配置落在 `~/.dsh/dsh-update-hub/settings.json`，缓存落在同目录的 `latest-cache.json`，客户端诊断落在 `client-diag.ndjson`（只在状态变化时写，单页最多 40 条）。

## 路由

前缀 `/_dsh/dsh-update-hub`，鉴权走 `connection.requestRejection`（Web 与桌面端共用的那道边界）。

| 方法 | 作用 |
|---|---|
| `state` | 行 + 任务状态 + 设置 + 空闲状态 |
| `check` | 绕过缓存重查 registry |
| `run`（POST） | 开始批量安装，body `{items:[{name}]}` |
| `cancel`（POST） | 取消，正在装的这只会装完 |
| `align`（POST） | 把磁盘实装版本写回清单，body `{name}` |
| `heartbeat`（POST） | 界面心跳，body `{visible, touched}`；返回任务状态 |
| `settings`（POST） | 改自动化设置，非法值会被拒 |
| `diag`（POST） | 客户端诊断，只追加、不抛错 |

## 边界

- 只处理 `package.json` 里声明的、registry 来源的依赖。`link:` / `file:` / `workspace:` / git 来源一律跳过（它们的版本来自工作树，不是 registry）。
- 不碰 `dsh.profile.bundles`：启用与停用仍由你或宿主决定。
- 不 kill、不 spawn、不写计划任务、不改 shell 配置。
- **pnpm 的定位有默认值，但可覆盖。** 优先从宿主的 `process.execPath` 推导自带 runtime，其次查 `DSH_APP_ROOT`（默认 `D:\program\harness`）与 `~/.dsh/dsh-runtimes`。DSH 装在别处时用 `DSH_UPDATE_HUB_PNPM`（直接指向 `pnpm.cjs`）或 `DSH_APP_ROOT` 指定；找不到时该行的失败原因会写明，不会静默跳过。profile 与数据目录同理支持 `DSH_PROFILE_DIR` / `DSH_HOME`。
