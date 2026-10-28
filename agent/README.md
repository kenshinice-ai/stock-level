# iPhone 到货监控（本地脚本 + Telegram 提醒）

在你自己的电脑上运行，定时查询澳洲 Apple Store 的门店取货库存，有货时**几秒内**推送 Telegram（Mac 上还会语音播报）。

为什么跑在本地：Apple 会拦截很多云服务器 IP 的查询（返回 HTTP 541），家里宽带一般没问题。脚本只用 Node 自带功能，无需 `npm install`。

## 1. 准备

- Node.js 20.6 以上（`node -v` 查看；没有的话 https://nodejs.org 下载 LTS）
- 克隆本仓库：

```bash
git clone https://github.com/kenshinice-ai/stock-level.git
```

```bash
cd stock-level && cp agent/.env.example agent/.env
```

## 2. 建 Telegram 机器人（3 分钟）

1. Telegram 里找 **@BotFather** → 发 `/newbot` → 按提示起名 → 拿到 token（形如 `123456789:AAH...`）。用 `nano agent/.env` 打开，粘贴到 `TELEGRAM_BOT_TOKEN=` 后面（不要空格），按 `Ctrl+O` 回车保存，`Ctrl+X` 退出。
2. 打开你新建的机器人，随便发一条消息（比如 `/start`）。
3. 运行下面命令。只有一个对话时会自动把 `TELEGRAM_CHAT_ID` 写进 `agent/.env`：

```bash
node --env-file=agent/.env agent/apple-agent.mjs --telegram-setup
```

4. 发一条测试提醒，确认手机能收到（记得打开 Telegram 通知）：

```bash
node --env-file=agent/.env agent/apple-agent.mjs --test-alert
```

## 3. 先查一次

```bash
node --env-file=agent/.env agent/apple-agent.mjs --once
```

能看到每家门店 `sold out` / `IN STOCK` 就说明可以正常访问 Apple。如果出现 `HTTP 541` / `403`，说明当前网络被 Apple 拦了：关掉 VPN / 代理，或换手机热点再试。

## 4. 开始监控

```bash
node --env-file=agent/.env agent/apple-agent.mjs
```

Mac 上防止睡眠（合盖不行，屏幕可以关）：

```bash
caffeinate -i node --env-file=agent/.env agent/apple-agent.mjs
```

## 配置（agent/.env）

| 变量 | 说明 | 例子 |
|---|---|---|
| `FAMILY` | `iphoneduo` / `iphone18promax` / `iphone18pro` | `iphoneduo` |
| `STORES` | `all`、州（`VIC`）、门店号（`R180`）、门店名，逗号分隔 | `VIC` 或 `R180,R343,R342` |
| `CAPS` | 容量过滤，空 = 任意 | `256gb,512gb` |
| `COLORS` | 颜色过滤，空 = 任意（Duo：`nightsky` / `starwhite`） | `nightsky` |
| `INTERVAL_SEC` | 检查间隔（秒，最小 15，实际 ±20% 随机） | `30` |
| `TELEGRAM_CHAT_ID` | 可填多个，逗号分隔（比如你和家人） | `123,456` |
| `SAY` | Mac 语音播报，`0` 关闭 | `1` |

墨尔本门店号：Chadstone `R180` · Southland `R343` · Doncaster `R342` · Highpoint `R504` · Fountain Gate `R530`。

请求量：每轮每个州 1 次请求（Apple 会一并返回附近门店），只看 VIC 就是每 30 秒 1 次请求。遇到限流会自动指数退避（最长 15 分钟），连续被拒会 Telegram 通知你。

## 收到提醒后怎么最快买到

库存通常只停留 **约 3 分钟**，提前准备好：

1. 手机 Safari / Apple Store App **提前登录 Apple ID**，Apple Pay 或信用卡准备好。
2. 收到提醒 → 点消息里的 Reserve 链接 → 选好型号 → **Pickup** → 选提醒里的那家门店 → 直接 Check Out。
3. 取货时带上带照片的证件和订单确认邮件。
4. 提醒只说明「检查时有货」，以 Apple 官网实际可下单为准；没抢到也别灰心，同一家店常一天补货多次（instockradar 统计的高峰在早上 8 点左右）。
