# xhh项目操作说明

## 星铁光锥文本抽取（2026-10-17 修，05530b1）

- 米游社光锥 wiki 原文的「技能」段首部混着侧栏导航词（基础介绍/命途/稀有度）与技能名，`extractHonkaiStarRailData`（apps/wiki.js:335）负责剥掉：先按「光锥描述」截断（防描述混入技能区），再逐个剥导航词，最后从首个谓语字（使/装/获/每当/其）截出正文；正文本身以谓语字开头的句式（「每有1个敌方目标…」）不再剥。
- `resources/wiki/gz.html` 技能区是 `{{@ jineng[1] || miaoshu}}`：函数万一抽取为空时回退光锥描述，不渲染空白。
- 改抽取逻辑后必须横扫多张 4/5 星光锥验证（不同光锥技能名长度差异大，惰性截断容易误伤），再模拟 loader 场景全链出图确认。

## 渲染模板 footer 规范

- 渲染图底部版权行文字格式固定为：`获取时间 {{generatedAt}} · from 小花火`（帮助页为 `from 小花火`）。
- 禁止在 footer 加「数据来源：xxx」之类前缀段；Alioth.wiki 等数据源信息写进图内说明区，不进 footer。
- footer 的颜色、字号沿用各模板现有值，不做跨模板统一（各深渊模板深色主题配色是有意差异）。

## 指令前缀

- 新增或移植指令的正则统一用可选前缀风格：`^#*(?:xhh|小花火)?...`，不强制 xhh 前缀，对齐 `abyss_report.js` 的既有写法。
- help.yaml 里的条目展示仍可带 `#xhh` 前缀（表示可用形式之一），正则必须保证不带前缀也能触发。

## 与上游同步（yu = **v2 分支** / xhh-TL）

- **上游看 `YUYUYUYU2147/xhh` 的 `v2` 分支（远端名 `upstream`），不是 `master`**：对比前先 `git fetch upstream v2`，
  一律以 `upstream/v2` 为准。`upstream/master` 那条线 2026-07-06 就停更了（tip f898ce6），拿它当上游会得出「上游没更新」的错误结论。
- 分支现状（2026-10-03 02:1x 实测）：`master` = f898ce6（07-06 停更）；`v2` = 2d2d9c2「doc:更新日志」(10-02 23:16)；
  `v3` = 0b9cd4f「perf(卡池): 自动刷新改为每 30 分钟一次」(10-03 01:54)，**比 v2 多 145 个提交**，是作者更靠前的那条线，偶尔有 v2 没有的修复。
- 本地 `master` 与上游的共同祖先停在 2026-05-28：本地领先 v2 77 个提交、v2 领先本地 519 个，属**内容相近但历史分叉**，
  v2 不能直接 merge，按文件或 cherry-pick 移植。
- **移植顺序：先 `upstream/v3`，v3 里没有再回 `upstream/v2`**（用户 2026-10-03 明确要求）；两者互有对方没有的提交，v3 通常更新。
- v3 的 `CHANGELOG.md` 抬头写的是「本文件记录 `v2+v3` 分支」，双线同时开发——查上游改了什么，以该 md 的「未发布 / 速览」表为准，再按条目去 v3（其次 v2）找实现提交。
- yu（YUYUYUYU2147/xhh）与本地有共同祖先，可 cherry-pick；xhh-TL（cchanlan）是独立历史（`git merge-base HEAD xhh-TL/master` 返回空），只能按文件手工移植。
- 上游与本地是**并行实现**（本地 apps 有 captchaNotice.js / sr_strategy.js / currency_ledger.js / system/manual_geetest.js，上游对应的是 currency_balance.js / service/geetest/*）：一律按功能适配，禁止整文件覆盖本地同名文件。
- cherry-pick 遇到"整文件冲突"且差异行数远超文件行数时，先怀疑行尾伪冲突：用 `diff <(git show X:f | tr -d '\r') <(git show Y:f | tr -d '\r')` 核对真实差异，再用规范化三方合并（`git merge-file`），不要在原始冲突标记里盲目选边。
- 已配置 `.gitattributes`（`* text=auto`）全库 LF；旧 CRLF 文件已一次性 renormalize。后续从本机（Windows）同步内容时注意本机工作区仍是 CRLF，提交时靠 autocrlf/attributes 转换。

## 图鉴别名解析链（wiki.js）

- 顺序固定为：本地 yaml 表 → 官方 wiki 条目（ZZZ 专用）→ ZZZ-Plugin/喵喵插件别名 → **Atlas 别名渠道**（plugins/Atlas，最后兜底），本地表优先、后查不覆盖已有键。
- Atlas 数据形态：原神/ZZZ 的 `othername/*.yaml` 是「正式名: [别名...]」；星铁 `othername.json` 是「类目: {id: [正式名, 别名...]}」（数组首元素为正式名），经 `atlasAliasMap()` 归一化构建、`atlasResolve()` 反查。
- 已接入：gs/sr 武器与角色、gs 圣遗物、sr 遗器（syw_yiqi）、ZZZ 43/44/45/46 全渠道（zzzAliasMap 并入）。BH3 无 Atlas 表，维持本地 bh3_*_names。
- `ZZZ_ALIAS_FILES` 必须含 44(邦布)/46(驱动盘)；此前缺 44/46 时 `zzzAliasMap` 会错落到 43 代理人表。`zzz_bb_names.yaml`/`zzz_syw_names.yaml` 本地暂缺，`zzzAliasMap` 已做 existsSync 前置，缺失时安全落到 Atlas 表。

- 图鉴最终数据源是米游社图鉴接口动态列表（gs=obc、zzz=官方wiki），别名层只是入口；Atlas/本地表解析出的正式名能直接按 title 匹配动态列表，不要求本地 yaml 先收录新条目。新增角色/套装查不到时先确认动态列表里有条目，再查别名链哪层没接上。
- ZZZ 专属音擎判定：role detail 直查 → 米游社官方 wiki 音擎列表（标题/摘要含角色名且为 S 级）→ ZZZ-Plugin WeaponId2Data 描述匹配。ZZZ-Plugin 表更新滞后，新角色勿只依赖它。
- 装备快捷词（专武/专属音擎/签名音擎/专属驱动盘/推荐驱动盘/驱动盘套/驱动套）结尾的指令免「图鉴」后缀（wiki.js 第三条规则）；普通条目名不做图鉴可选——wiki 优先级 -99 会先于其他插件吃到消息，宽匹配会吞普通聊天。
- 新角色的专属装备数据可能滞后于米游社官方 wiki（如洛克茜音擎词条未建时全部判定源失配，属数据缺失非代码问题）；判定链已按 detail 直查→官方 wiki→ZZZ-Plugin 兜底排布，数据源更新后自动生效。

## 图鉴快捷写法与强制前缀（2026-10-16 收紧，1a80237）

- 游戏前缀语义：原神`#`、星铁`*`、绝区零`%`、崩三`!`（全角 ＃＊％！ 同义）；**指令必须以符号前缀开头**。写游戏名（「星铁希儿图鉴」）不能顶替前缀，同样不响应；「#星铁希儿图鉴」合法（符号优先，游戏名由名字清洗剥掉）。有前缀时「图鉴」可省（`%绯月`、`#可可莉`、`%洛克茜专武`）。
- **游戏判定依赖 TRSS loader 改写（关键坑，2026-10-17 补）**：loader 在派发前把 `*x`/`%x` 重写成 `#星铁x`/`#绝区零x`（`lib/plugins/loader.js:307/310`）并设 `e.game`——本插件收到的消息首字符恒为 `#`，只看首符号会把 %/* 查询误判成原神（1a80237 曾踩此坑：`%法厄同之歌` 日志报「原神侧未命中」）。入口现在以 `e.game`（loader 注入）优先，无标志（!崩三/全角前缀等不改写形态）才用首符号判定。给图鉴新增游戏判定逻辑时同理：**不要信 msg 首字符，信 e.game 或 raw_message**。
- 无前缀消息完全静默：规则层三条 reg 前缀量词 `*`→`+`，入口层已删 keywordGame（游戏关键词不再参与判游戏）。跨游戏无谓试探（撞 CDN 坏节点拖几分钟）的路径随之消失。
- 缺/错前缀唯一回复场景：消息以「图鉴」开头或结尾且 ≤30 字（「图鉴希儿」「希儿图鉴」）→ 回一次前缀用法提示后放行（return false）；句中含「图鉴」的普通聊天（「帮我看看图鉴怎么做」）静默，防误伤。
- 诊断变化：不存在「无前缀走哪个分支」的问题——先看消息首字符是不是合法前缀符号，不是就直接静默/HINT；前缀消息查不到仍按各自游戏分支排查（日志 `[xhh][图鉴] ... 原神侧未命中` 即 # 消息原神侧失败）。
- ZZZ 专属装备本地映射表 `system/default/zzz_exclusive_map.yaml`（角色名: [音擎|驱动盘]），挂 `findZzzSignatureWeapon`/`findZzzRecommendDrives` 判定链最前，用于数据源空窗期手工兜底（如洛克茜→绯月银棺，各数据源均无角色关联字段）。
- ZZZ 图鉴数据源实际顺序：nanoka（`static.nanoka.cc`，版本号硬编码在 `ZZZ_NANOKA_VERSION`）→ 官方 wiki 回退；nanoka 常常比官方 wiki 新（绯月银棺只在 nanoka 有）。诊断「某条目查不到」先分清条目层（nanoka/wiki 有没有）和关联层（有没有角色关联字段）。
- `#`/`*`/`%`/`!` 前缀消息只走对应游戏分支（2026-10-16 起无前缀消息不再进入图鉴解析，见上方「图鉴快捷写法与强制前缀」）。诊断某前缀消息查不到时，先看它进的是哪个分支：%/* 消息经 loader 改写后查 `e.game`（日志无「原神侧未命中」却查不到 = 先怀疑 game 判定，再查数据层）。
- 新角色/新武器查不到的另一层原因：别名渠道（喵喵/Atlas/本地yaml）全部滞后。role/weapon 已支持"原名直查米游社图鉴列表精确匹配"（title==name），新条目在米游社收录后即可出图，无需等别名表。


## 米游社请求统一入口（mysReq）

- `utils/mysReq.js` 是米游社请求的统一入口：米游社/米哈游系域名（miyoushe.com、mihoyo.com、hoyolab、hoyoverse）走云崽 `lib/common/mys.js` 的 `mysFetch`（节点采集→测速选优→失败换 IP→粘滞缓存），其余域名回退全局 `fetch`，写法与 `fetch` 相同。
- 新增访问米游社的代码请用 `mysReq`，不要再直接 `fetch`；纯第三方域名（bwiki/alioth/nanoka/B站等）无需替换，会自动走回退。
- `mysFetch` 不解压响应（也不会主动声明 `Accept-Encoding`），`res.headers` 是原始头对象——`mysReq` 已把它包成 `Headers` 实例，`res.headers.get(...)` 照常可用。
- 批量替换时注意别改到类方法定义（如 `gacha_pool_official.js` 的 `async fetch(game, ...)`）与 `this.fetch(...)`/`officialPool.fetch(...)` 这类方法调用。

## 兑换码（apps/redeemCodes.js + utils/redeemClient.js，2026-11-06 移植自 xhh-TL）

- **国服兑换码可能是中文**：原神/星铁 7.x 的前瞻码形如「坏灭肇始之时」，不是 `[A-Z0-9]`。码校验统一用 `utils/redeemClient.js` 的 `CODE_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{2,64}$/`，`parseCommand` 与 `normalizeCodes` 共用；改成纯英文数字会把国服真码全过滤掉，表现成「自动兑换永远没码」。
- 码源只有官方前瞻一处（`official()`：官方号动态 → act_id → miyolive → refreshCode）。社区站 `db.hashblen.com/codes` 是**国际服**汇总（STARRAILGIFT/ZENLESSGIFT 等），国服不可用，已移除，不要接回来。
- 非直播期 `refreshCode` 返回 `活动已结束 (-500012)` 是正常情况，不是故障。
- 自带 `plugins/genshin/apps/exchange.js`（priority -1000）与本插件重叠不冲突：本插件 priority -100 先接管 `#兑换码使用XXX`，`#兑换码`（不带「使用」）仍走自带。
- 订阅按 `[bot, qq, game]` 存（`subKey`），开启后兑的是**该 QQ 名下该游戏的全部绑定 uid**，不是全局所有用户。
- 自测：`cd /root/Yunzai && node plugins/xhh/temp/redeem-selftest.mjs`（29 例）。cwd 必须是 `/root/Yunzai`，脚本内先 stub 全局量，否则 `#xhh` 链读不到 `config/default_config/`。
- `utils/redeemClient.js` 不在热加载范围（`/root/Yunzai/AGENTS.md` 第 30/36 行），改它之后要 `#重启`。
- **兑换怎么落到账号上**：`GET https://hk4e-api.mihoyo.com/common/apicdkey/api/webExchangeCdkey?uid=&region=&cdkey=&game_biz=hk4e_cn&lang=zh-cn`，header 只带 `Cookie` + `Referer`，**不需要 DS 签名**（`utils/redeemClient.js:181-194` 的注释与实测都印证：Cookie 有效时返回的是码本身的错误如 `-2001 兑换码已过期`，Cookie 无效才会是 `-100/-1071`）。这不是往游戏账号里写数据，是请求官方服务器校验 CDK 后把奖励投进该 `uid` 的游戏内邮箱，玩家下次登录在邮箱领。星铁/绝区零同构，只换 host 与 `game_biz`（`hkrpg_cn`/`nap_cn`）。
- **`region` 必须与角色实际区服一致**（官服 `cn_gf01`、B服 `cn_qd01` 等），由 `getUserGameRolesByCookie` 返回的 `region` 提供，不要写死；`game_uid` 与 `region` 错配会兑换失败。
- **这是官方网页在用的接口，但不是开放 API**：没有文档、无开发者授权、有频率与风控（`-2016` 冷却、`-1033/-1035/-1071/-100` 鉴权或风控）。游戏内「设置→账户→兑换码」走客户端协议，与这条 HTTP 路径不是同一条，别混为一谈。
- **国服没有任何面向用户的兑换页**：2026-11-06 实测 `webstatic.mihoyo.com/bbs/event/cdkey/index.html`、同站 `/ys/event/`、`/common/`、`/app/community-game-fe/cdkey/`、老域名 `bbs.mihoyo.com/bbs/event/`、`www.miyoushe.com/bbs/event/` 与 `act.mihoyo.com/event/cdkey/` 全部 404；同一天用 adb 遍历米游社 App（「我的」七宫格 = 兑换中心/创作中心/米游铺/奇匠中心/米游币/游戏中心/支付中心、星铁工具箱全项、工具集合页「其他工具」横滑到底）也没有任何兑换码入口。**国服入口只有游戏内「设置→账户→兑换码」**。`webExchangeCdkey` 我们能直接调通（见上条），但它对应的官方前端入口找不到，不要再去找「网页版兑换页」，它不存在。网页兑换只有**国际服**有：`https://www.hoyolab.com/redeem`（实测 200，对应接口是 `webExchangeCdkeyHyl`，host 形如 `sg-hk4e-api.hoyolab.com`，与国服的 `webExchangeCdkey` 不是同一套）。
- **`Cookie` 等于账号登录态**（`ltuid` + `cookie_token`/`stoken`），兑换请求必须带；日志与报错里不得打印 Cookie 原文。

## 沙盒验证（改完必跑）

判定只看 `result.replies` 里有没有内容；`hit` 只说明规则接住了，规则接住后抛错或提前 return 一样没有回复。完整 12 条在上级 `/root/Yunzai/AGENTS.md` 的「沙盒验证纪律」小节（第 105–127 行），这里只列三条最容易踩空的：

- `scene.groupId` 必须传**指令群**（群号见本机 `config/config/other.yaml` 的 whiteGroup）。沙盒默认的假群 `100000000` 不在 `config/config/other.yaml` 的 `whiteGroup` 里，`PluginsLoader.checkBlack()` 静默返回 false，表现为 `blocked:"blacklist"`、`elapsed:0`、零回复（2026-10-02、11-06 各踩一次）。
- 请求体字段是 `{scene, text, images, reply}`（`plugins/Guoba-Plugin/server/controller/biz/SandboxController.js` 的 `req.body` 解构）。正文必须用 **`text`**，写成 `message` / `msg` / `content` 一律返回「消息内容不能为空」。
- token 取 Redis `Yz:Guoba:access-token:*` 里 iat 最大的一条；`scene` 直接拿 `GET /guoba/api/sandbox/defaults` 返回值，只把 `groupId` 换成指令群群号。

## 手动过码服务端口

- `manual_gt_port` 在本机已从默认 3000 改为 **8767**：3000-3001 被 napcat 容器（docker）占用，
  用默认值会报 `EADDRINUSE ... 0.0.0.0:3000`，服务起不来（日志 `[xhh][manual_gt] 服务启动失败`）。
- 8766 是自动过码服务（geetest-solver），8767 是手动过码服务，两者互不影响。

## 图鉴数据磁盘缓存

- 位置：`plugins/xhh/data/cache/http/`（文件名 = URL 的 sha1 前 20 位；`data/` 已被 .gitignore 忽略）。
- 规则（写在 `utils/mysReq.js`）：`static.nanoka.cc` TTL 7 天；米游社/米游社的 `/common/blackboard/` 图鉴接口 TTL 12 小时。
  只缓存 GET 且不带 Cookie/DS/x-rpc-* 的请求；单条 2MB 上限；文件超 3000 个按最旧 20% 清理。
- 取数失败时会回退本地旧副本（日志 `[xhh][cache] ... 改用本地缓存兜底`），所以图鉴在 CDN 抽风时仍可用。
- 想强制刷新：删掉该 URL 对应的缓存文件，或清空整个 `data/cache/http/` 目录。
