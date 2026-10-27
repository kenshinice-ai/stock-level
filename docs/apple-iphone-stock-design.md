# Apple iPhone（Duo / 18 Pro / 18 Pro Max）门店取货库存查询 — 设计方案

> 状态：设计稿（未实现）· 日期：2026-10-28
> 目标：在现有 `stock-level`（Officeworks 库存查询，Cloudflare Worker）基础上，增加 Apple Store 澳洲 21 家门店的 iPhone 取货库存实时查询 + 到货提醒。

---

## 1. 调研结论

### 1.1 instockradar.com/au 是怎么做的

通过读取它的页面 HTML（`<script id="page-data">` 内嵌 JSON）和前端 `app.js`，可以确认其架构：

| 层 | 做法 |
|---|---|
| **数据源** | 读取 Apple 公开的「门店取货可用性」（FAQ 原话：*reads Apple's public pickup availability*），即 Apple 商品页「Check availability」背后的接口。 |
| **采集模式** | **服务端集中轮询**，不是用户来一个查一次。新机型每几分钟扫一遍全部门店；有付费提醒指向的门店/城市提速到 **每 20 秒**；老机型每小时。 |
| **快照格式** | 每个 `(国家, 机型族)` 一份快照：`{v, ts, stores: {R238: {c: 上次检查时间, a: [[部件号, 到货时间]], np: 1(不支持取货)}}}`，非常紧凑。 |
| **实时推送** | 浏览器连 `wss://…/api/live?cc=au&f=iphoneduo` 接收 **diff**：`ch:[[门店, 部件号, 是否有货, ts, 机型族]]`（库存变化）、`ck:[["R238|iphoneduo", ts]]`（检查时间刷新）；WebSocket 断开 4 次后降级为每 60 秒 `GET /api/stock?cc=au&family=…` 轮询。 |
| **历史统计** | 记录每次「到货 → 售罄」事件，算出：30 天到货次数、典型在库时长（AU 的 Duo 约 **3 分钟**）、最常见到货小时、各门店最近一次到货。 |
| **转化** | 有货卡片上的「Reserve」直接跳 `https://www.apple.com/au/shop/product/{部件号}`；提醒是付费的（Telegram / Web Push(PWA) / Email），中位延迟 4 秒。 |
| **反爬** | 它自己的 `/api/stock` 对非浏览器请求直接返回 `429 "Automated reads of store stock are not allowed"` —— **我们不应、也无法以它为数据源**，只借鉴设计。 |

页面内嵌的配置（直接可用作我们的种子数据）：

**机型 → 部件号（AU，`X/A` 后缀）**

| 机型族 | 容量/颜色 → 部件号 (价格 AUD) |
|---|---|
| iPhone Duo (`iphoneduo`) | 256GB Night Sky `MK2E4X/A` · 256GB Star White `MK2D4X/A` (3499) · 512GB `MK2G4X/A` / `MK2F4X/A` (3899) · 1TB `MK2J4X/A` / `MK2H4X/A` (4699) · 2TB `MK2L4X/A` / `MK2K4X/A` (5899) |
| iPhone 18 Pro Max (`iphone18promax`) | 256GB Black/Burgundy/Glacier/Silver `MJXN4X/A` `MJXQ4X/A` `MJXR4X/A` `MJXP4X/A` (2299) · 512GB `MJXT/MJXV/MJXW/MJXU4X/A` (2699) · 1TB `MJXX/MJY0/MJY1/MJXY4X/A` (3499) · 2TB `MJY2/MJY4/MJY5/MJY34X/A` (4699) |
| iPhone 18 Pro (`iphone18pro`) | 256GB `MJRP/MJRR/MJRT/MJRQ4X/A` (2099) · 512GB `MJRU/MJRW/MJRX/MJRV4X/A` (2499) · 1TB `MJRY/MJT1/MJT2/MJT04X/A` (3299) · 2TB `MJT3/MJT5/MJT6/MJT44X/A` (4499) |

**AU 21 家 Apple Store（门店号 / 名称 / 城市 / 时区）**

R254 Bondi · R508 Booragoon · R466 Brisbane · R523 Broadway · R483 Canberra · R509 Carindale · R344 Castle Towers · R180 Chadstone · R385 Charlestown · R253 Chatswood Chase · R384 Chermside（当前不支持取货）· R342 Doncaster · R530 Fountain Gate · R504 Highpoint · R606 Miranda · R440 Penrith · R386 Perth City · R351 Robina · R405 Rundle Place · R343 Southland · R238 Sydney

（经纬度也在 page-data 里，可用于「离我最近」排序。）

### 1.2 GitHub 上的开源实现

| 项目 | 接口 | 值得借鉴的点 |
|---|---|---|
| [worthbak/apple-store-inventory-checker](https://github.com/worthbak/apple-store-inventory-checker) (Node) | `GET https://www.apple.com/{cc}/shop/fulfillment-messages?parts.0=…&parts.1=…&searchNearby=true&store=R172` | ① **一次请求带多个 parts + `searchNearby=true`，返回锚点门店周边约十几家门店**，大幅减少请求数；② 解析 `body.content.pickupMessage.stores[].partsAvailability[part].pickupDisplay === "available"`；③ **对照 SKU（control part）**：带一个几乎永远有货的部件，若它也显示无货 / `storeSearchEnabled !== true`，说明是接口异常而不是真的售罄。cron 每分钟一次。 |
| [insanoid/Apple-Store-Reserve-Monitor](https://github.com/insanoid/Apple-Store-Reserve-Monitor) (Python) | `/{cc}/shop/product-locator-meta?family=…`（拉某机型族全部部件号）+ `/{cc}/shop/retail/pickup-message?pl=true&parts.0=…&location=邮编` | ① 用 `product-locator-meta` **自动发现部件号**，新机型发布不用手抄；② 按 `location=邮编` 查附近门店；③ 30 秒轮询。 |
| TomThorpe/NodeiPhoneStockChecker、alexeckermann 的 gist（2016 AU iPhone 7） | 旧的 `reserve-prod.apple.com/…/availability.json`（已停用） | 历史参考：思路一直是「按国家拉全量 → 本地 diff → 通知」。 |

**关键响应字段**（fulfillment-messages，社区实现中稳定使用多年）：

```text
body.content.pickupMessage.stores[] :
  storeNumber        "R238"
  storeName          "Sydney"
  city / state
  storePickEligible  false → 该店当前不提供取货（对应 instockradar 的 np）
  partsAvailability[ "MK2E4X/A" ]:
      pickupDisplay           "available" | "unavailable" | "ineligible"
      storeSearchEnabled      true/false（false = 搜索不可用，结果不可信）
      pickupSearchQuote       "Today" / "Currently unavailable" 等文案
      messageTypes.regular.storePickupQuote
```

### 1.3 我们自己的 Officeworks 项目（`worker.js` + `public/index.html`）

| 现状 | 对 Apple 场景的影响 |
|---|---|
| **按需扇出**：用户点查询 → Worker 现场对每家门店调用 `catalogue-app/api/availabilities/store/{storeId}/postcode/{postcode}`，前端用 `offset/limit=20` 分批、`mapLimit(4)` 并发 | Apple 场景不适用：库存只存在约 3 分钟，用户来查时早没了；且 N 个访客 = N 倍上游请求，很快被 Apple 拦。**必须改成服务端定时采集 + 共享快照**。 |
| `caches.default` 缓存门店列表(12h)和商品信息(1h) | 可复用：Apple 门店表、机型配置同样缓存。 |
| 无状态、无历史 | Apple 需要状态（上一轮快照做 diff）和历史（到货事件、统计）→ 引入 Durable Object + D1。 |
| 前端中英双语、卡片式结果、状态/进度条 | UI 风格、i18n 机制直接沿用。 |
| 工具函数 `fetchJson / mapLimit / json() / CORS` | 抽到 `src/lib/` 复用。 |

### 1.4 本环境实测

从当前云容器直接请求 `https://www.apple.com/au/shop/fulfillment-messages?...` 返回 **HTTP 541**（Apple 对数据中心 IP 的拦截页）。这意味着：**Cloudflare Worker 出口 IP 是否能访问该接口必须先做 Spike 验证**（见 §6 Phase 0），方案里要预留「家庭采集器」备选路径。我们不做 IP 轮换 / 伪造指纹之类的绕过，只做低频、合规的读取。

---

## 2. 设计目标

1. **看得到**：打开页面即可看到 AU 21 家门店各机型/容量/颜色当前是否可取货、「从几点起有货」「X 秒前检查」。
2. **够快**：默认每 60 秒全量一轮；被订阅的门店 20 秒一轮。页面通过 WebSocket 秒级更新。
3. **抓得住**：到货时 Telegram / Web Push 秒级提醒（先做 Telegram，免费且实现最简单）。
4. **有数据**：记录到货事件，给出「典型在库时长」「几点最常到货」。
5. **对上游友好**：所有访客共享同一份快照，访问量与上游请求数解耦；总请求量 ≤ 每分钟十几次。
6. **兼容 Officeworks**：抽象出 Provider 接口，两个零售商共用一套前端/API 外壳。

---

## 3. 总体架构

```text
                       ┌──────────────────────── Cloudflare ────────────────────────┐
 Cron Trigger (1 min) ─┤                                                            │
                       │  Worker (worker.js 路由)                                   │
 Browser ── HTTPS ────▶│   /api/apple/stock   ─┐                                     │
 Browser ── WSS  ─────▶│   /api/apple/live    ─┼─▶ Durable Object  StockHub("au")   │
 Telegram webhook ────▶│   /api/alerts/*      ─┘     • 当前快照 (DO storage)         │
 Home agent (备选) ───▶│   /api/apple/ingest (HMAC)  • alarm(): 20s/60s 调度采集     │
                       │                             • diff → WS 广播 → 提醒队列     │
                       │   /api/check (Officeworks, 保持不变)                        │
                       │                                                            │
                       │  D1: restock_events / alerts / subscribers                 │
                       │  KV/Cache: 机型配置、门店表                                 │
                       └───────────────┬────────────────────────────────────────────┘
                                       │ fetch (低频)
                                       ▼
                    apple.com/au/shop/fulfillment-messages
```

### 3.1 为什么用 Durable Object（DO）

- **单点状态**：一个国家一个 DO 实例（`idFromName("au")`），天然串行，diff 不会有竞争。
- **亚分钟调度**：Cron 最小 1 分钟；DO `alarm()` 可以 20 秒自我续约，实现「热门门店 20 秒」。
- **WebSocket Hub**：DO 支持 WebSocket Hibernation，所有浏览器连接挂在同一个 DO 上，diff 一次广播，空闲时不计费。
- Cron 只负责「保活」：每分钟 ping 一下 DO，确保 alarm 链不断。

---

## 4. 采集设计（核心）

### 4.1 请求策略：锚点门店 + searchNearby

一次 `fulfillment-messages` 请求 = 1 个锚点门店 × 多个 parts，返回锚点周边多家门店。选 5～6 个锚点即可覆盖 AU 全部 21 家：

| 锚点 | 预期覆盖 |
|---|---|
| R238 Sydney | Sydney / Broadway / Bondi / Chatswood / Miranda / Castle Towers / Penrith / Charlestown / Canberra |
| R180 Chadstone | Chadstone / Southland / Doncaster / Fountain Gate / Highpoint |
| R466 Brisbane | Brisbane / Carindale / Chermside / Robina |
| R405 Rundle Place | Adelaide |
| R386 Perth City | Perth City / Booragoon |

- 锚点表不写死：首次运行时对每家门店做一次请求，记录「每家店被哪些锚点覆盖」，自动求最小覆盖集，存 KV；每天重算一次。
- **parts 分组**：一次带一个机型族的全部部件（Duo 8 个、Pro/Pro Max 各 16 个）+ 1 个 control part。若 URL 过长或接口有上限，按容量拆组。
- 请求量估算：3 个机型族 × 5 锚点 = **15 次 / 轮**。常规 60 秒一轮 → 15 req/min；热点模式只对「有订阅的锚点 × 机型族」20 秒一轮。

### 4.2 Provider 接口（Apple / Officeworks 共用）

```js
// src/providers/apple.js
export const apple = {
  id: "apple",
  async listStores(cc) {},                       // → [{id, name, city, lat, lng, tz}]
  async listFamilies(cc) {},                     // → [{family, name, parts:{part:[cap,color,price]}}]
  async checkAnchor(cc, anchorStore, parts) {},  // → [{storeId, pickupEligible, parts:{part: "available"|"unavailable"|"ineligible"}, searchOk}]
};
```

`checkAnchor` 实现要点：

```js
const qs = new URLSearchParams({ pl: "true", "mts.0": "regular", searchNearby: "true", store: anchor });
parts.forEach((p, i) => qs.set(`parts.${i}`, p));
const url = `https://www.apple.com/${cc}/shop/fulfillment-messages?${qs}`;
// fetchJson 复用现有实现：超时 8s、非 2xx 抛错、非 JSON 抛错
// 541 / 403 / 429 / HTML 响应 → 标记 upstream_blocked，触发退避
const stores = data?.body?.content?.pickupMessage?.stores ?? [];
```

**数据可信度判定**（借鉴 worthbak 的 control part）：

- control part（选一个常年有货的配件部件号，Phase 0 时从 apple.com/au 选定并验证）在该店显示 `unavailable` 或 `storeSearchEnabled !== true` → 本店本轮结果标记 `stale`，**不产生「售罄」事件**，保持上一轮状态。
- `storePickEligible === false` → 门店 `np: 1`（UI 显示「暂不支持取货」）。

### 4.3 状态机与事件

每个 `(store, part)` 一个状态：

```text
 unknown ──available──▶ IN_STOCK(since=ts) ──unavailable × 2 轮──▶ OUT(lastRestock=since, duration)
    ▲                                                                 │
    └──────────────────────────── available ──────────────────────────┘
```

- **到货**：`unavailable → available`，**第一次看到就触发**（库存只存在约 3 分钟，不能等确认）。
- **售罄**：需要 **连续 2 轮** `unavailable` 才关闭，避免抖动产生重复到货/重复提醒。
- **去抖**：同一 `(store, part)` 售罄后 90 秒内再次 available，视为同一次到货的延续（不重复提醒）。
- 关闭时写一条 D1 `restock_events(cc, family, store, part, start_ts, end_ts, duration_s)`。

### 4.4 退避与健康

- 上游返回 541/403/429：该锚点指数退避（30s → 1m → 2m → … 封顶 15m），全局连续失败 → 暂停热点模式，UI 顶部显示「数据延迟」。
- 每轮写 `health`：成功率、延迟、最后成功时间；`/api/apple/health` 暴露，便于监控。
- 请求头只带正常的 `Accept` / `User-Agent` / `Referer`，不做指纹伪造、不轮换 IP。

### 4.5 Phase 0 若 Worker 出口被拦：家庭采集器（备选）

- 一个约 100 行的 Node 脚本（`agent/apple-agent.mjs`），运行在家里的 Mac / 树莓派 / NAS 上，按 §4.1 同样的策略低频请求 Apple。
- 结果 `POST /api/apple/ingest`（HMAC-SHA256 签名，密钥放 `wrangler secret`），DO 接收后走同样的 diff / 广播 / 提醒流程。
- Worker 端的采集器与家庭采集器共用 `parseFulfillment()`，放在 `src/providers/apple-parse.js`，两边 import。

---

## 5. 数据与 API

### 5.1 快照（DO storage，与 instockradar 同构，前端友好）

```json
{
  "cc": "au", "family": "iphoneduo", "v": 23, "ts": 1793144863,
  "stores": {
    "R351": { "c": 1793144853, "a": [["MK2D4X/A", 1793144480], ["MK2E4X/A", 1793144480]] },
    "R384": { "c": null, "a": [], "np": 1 },
    "R238": { "c": 1793144853, "a": [], "stale": 0 }
  },
  "last": { "R238": [1793144201, "MK2E4X/A"] }
}
```

### 5.2 WebSocket diff

```json
{ "ch": [["R351", "MK2E4X/A", 1, 1793144480, "iphoneduo"]],
  "ck": [["R351|iphoneduo", 1793144853]] }
```

### 5.3 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apple/config?cc=au` | 门店表 + 机型族/部件号/颜色/容量/价格 |
| GET | `/api/apple/stock?cc=au&family=iphoneduo` | 当前快照（`Cache-Control: max-age=5`，所有访客共享） |
| WS | `/api/apple/live?cc=au&f=iphoneduo` | diff 推送；客户端 30s ping；断线指数重连，4 次失败降级 60s 轮询 |
| GET | `/api/apple/stats?cc=au&family=iphoneduo&days=30` | 到货次数、典型在库时长（中位数）、24 小时分布、各店最近到货 |
| GET | `/api/apple/health` | 采集健康状况 |
| POST | `/api/apple/ingest` | 家庭采集器上报（HMAC） |
| POST | `/api/alerts` / DELETE `/api/alerts/:id` | 创建/删除提醒（Telegram chat_id 或 Web Push subscription） |
| POST | `/api/telegram/webhook` | Telegram bot `/start` 绑定、`/stop` 退订 |
| GET | `/api/check` 等 | **Officeworks 现有接口保持不变** |

### 5.4 D1 表

```sql
CREATE TABLE restock_events (
  id INTEGER PRIMARY KEY, cc TEXT, family TEXT, store TEXT, part TEXT,
  start_ts INTEGER, end_ts INTEGER, duration_s INTEGER
);
CREATE INDEX idx_re_family_ts ON restock_events(cc, family, start_ts);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY, channel TEXT,           -- 'telegram' | 'webpush' | 'email'
  target TEXT,                                 -- chat_id / push subscription JSON / email
  cc TEXT, family TEXT,
  stores TEXT,                                 -- JSON 数组，空 = 全国；或 {lat,lng,km}
  caps TEXT, colors TEXT,                      -- JSON 数组，空 = 任意
  created_ts INTEGER, last_sent_ts INTEGER, active INTEGER DEFAULT 1
);
```

DO 启动时把 active alerts 读进内存，生成「热点集合」= 被订阅的 `(锚点, family)`，决定哪些走 20 秒一轮。

---

## 6. 提醒

- **匹配**：到货事件 `(store, part)` → 解析出 `(family, cap, color)` → 匹配 alerts（门店命中 / 距离命中 / 全国）。
- **频控**：同一 alert 同一店 10 分钟内只发一次；一次到货多颜色合并成一条消息。
- **Telegram**（Phase 2 首选）：`sendMessage` 带「Reserve on Apple」按钮 → `https://www.apple.com/au/shop/product/{part}`，以及门店导航链接。Bot token 用 `wrangler secret put TELEGRAM_BOT_TOKEN`。
- **Web Push**（Phase 3）：VAPID；iPhone 需「添加到主屏幕」作为 PWA 才能收推送（instockradar 也是这么引导的），需要补 `manifest.json` + Service Worker。
- 发送放在 `ctx.waitUntil()` / Queues 里，不阻塞采集循环。目标：从检测到发送 < 5 秒。

---

## 7. 前端

在现有 `public/index.html` 的风格和 i18n（中/EN）基础上：

1. 顶部零售商切换：**Apple iPhone** | Officeworks（Officeworks 页保持现在的 SKU 搜索）。
2. Apple 页筛选：机型（Duo / 18 Pro Max / 18 Pro）· 容量 · 颜色 · 「使用我的位置」（按经纬度排序，计算距离）。
3. 门店卡片：有货置顶、绿色；显示有货配置 chip（色块 + 容量）、「从 9:41 起有货」「13 秒前检查」、`Reserve`（跳 Apple 商品页）、`Directions`、`提醒我`。
4. 摘要条：「iPhone Duo 当前 3/21 家有货；最近一次到货 10:44 Canberra；典型在库 3 分钟」。
5. 统计区：24 小时到货分布柱状图、最近到货列表。
6. 实时：WebSocket 更新 + 新到货时卡片高亮和 `aria-live` 播报；每 30 秒重渲染相对时间；页面回到前台时补拉一次快照。

---

## 8. 代码结构（重构后）

```text
worker.js                 → 只做路由 + 导出 DO 类（保持 wrangler main 不变）
src/lib/http.js           → fetchJson / json / CORS / mapLimit（从现 worker.js 抽出）
src/providers/officeworks.js  → 现有 Officeworks 逻辑原样搬迁
src/providers/apple.js        → listStores / listFamilies / checkAnchor
src/providers/apple-parse.js  → parseFulfillment()（Worker 与家庭采集器共用，带单测）
src/apple/catalog.au.json     → 21 家门店 + 3 个机型族部件号（种子数据）
src/apple/hub.js              → Durable Object StockHub：alarm 调度、状态机、diff、WS
src/apple/alerts.js           → 匹配、频控、Telegram / Web Push 发送
agent/apple-agent.mjs         → 备选家庭采集器
migrations/0001_init.sql      → D1 表
public/index.html             → 加 Apple 视图（或拆 public/apple.html）
test/                         → vitest + @cloudflare/vitest-pool-workers；parse 用录制的 JSON fixture
```

`wrangler.toml` 新增：

```toml
[triggers]
crons = ["* * * * *"]

[[durable_objects.bindings]]
name = "STOCK_HUB"
class_name = "StockHub"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StockHub"]

[[d1_databases]]
binding = "DB"
database_name = "stock-level"
database_id = "<创建后填写>"
```

---

## 9. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Phase 0 · Spike（半天）** | 加 `/api/apple/raw?store=R238&parts=MK2E4X/A` 调试接口，部署到 workers.dev，验证 Worker 出口能否拿到 JSON；录制真实响应作为测试 fixture；选定 control part；跑一次锚点覆盖计算。 | 拿到 200 JSON → 走 Worker 采集；拿到 541/403 → 走 §4.5 家庭采集器。 |
| **Phase 1 · 只读 MVP（1–2 天）** | 重构目录；`apple-parse` + 单测；DO + Cron 60 秒采集；`/api/apple/stock` + `/api/apple/config`；前端 Apple 视图（先用 60 秒轮询）。 | 页面能看到 21 家门店真实状态，与 apple.com 手动核对一致。 |
| **Phase 2 · 实时 + 提醒（2 天）** | WebSocket hub；状态机 + D1 事件；Telegram bot 绑定和提醒；热点 20 秒模式；退避与 health。 | 人为订阅一家店，到货后 < 10 秒收到 Telegram。 |
| **Phase 3 · 统计 + PWA（2 天）** | `/api/apple/stats`、到货小时分布图；manifest + Service Worker + Web Push；部件号用 `product-locator-meta` 自动刷新。 | 统计数字随时间积累；iPhone 主屏 PWA 能收推送。 |
| **Phase 4 · 统一体验（可选）** | Officeworks 也接入 Provider 接口，支持「关注某 SKU 在某店补货」的 Telegram 提醒（复用同一套 alerts）。 | 两个零售商一套提醒体系。 |

---

## 10. 风险与原则

- **非官方接口**：`fulfillment-messages` 未公开文档，字段可能变化 → 解析层集中在 `apple-parse.js`，有 fixture 单测，字段缺失时降级为 `stale` 而不是误报「售罄」。
- **访问被拦**：本容器已实测 541。坚持低频、共享快照、指数退避，不做绕过反爬（不轮换 IP、不伪造浏览器指纹、不用住宅代理池）；被拦就降频或用家庭采集器。
- **不抓第三方站点**：instockradar 明确禁止自动读取（429），只作为产品设计参考。
- **免责声明**：页面注明「独立工具，与 Apple 无关；以 Apple 官网为准」，不代下单、不收款，只跳转 Apple 官方预约。
- **成本**：Workers Paid ($5/月) 足够：DO + D1 + Cron 用量都在免费额度内的量级；Telegram 免费。

---

## 参考

- instockradar.com/au（页面 `page-data` 与 `/app.js`，2026-10-28 读取）
- https://github.com/worthbak/apple-store-inventory-checker
- https://github.com/insanoid/Apple-Store-Reserve-Monitor
- https://github.com/TomThorpe/NodeiPhoneStockChecker
- https://gist.github.com/alexeckermann/18bc93b6c3f78df83c7fa32abbe221d4
- 本仓库 `worker.js`（Officeworks，VERSION `2026-07-03-v15-product-price-summary`）
