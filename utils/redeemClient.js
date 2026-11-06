/**
 * 三游戏兑换码：码源抓取与兑换请求。
 *
 * 移植自 xhh-TL（cchanlan）的 utils/redeemClient.js（提交 4ae715d + 23eae30）。
 * 与上游的差异只有网络层：按 master 的约定改走 utils/mysReq.js（米游社统一入口，
 * 节点优选 + 失败换 IP + 图鉴缓存），不再直接 node-fetch。其余逻辑（码源、时窗、
 * 缓存、返回码表）保持上游行为，方便日后跟上游对账。
 *
 * 码源只有官方一处：米游社官方账号的前瞻直播帖 → act_id → miyolive 拿 code_ver → refreshCode。
 * 上游原本还接 db.hashblen.com/codes，那是国际服汇总（STARRAILGIFT / ZENLESSGIFT 这类英文常驻码），
 * 国服用不上，已整条移除；自动兑换只认官方前瞻源（23eae30 的修正）。
 *
 * 国服兑换码原神与星铁早就改用中文了（如「坏灭肇始之时」），所以码的合法字符必须含汉字：
 * 只按 [A-Z0-9] 过滤会把真码全部丢掉，表现成「永远取不到码」。
 */
import mysReq from './mysReq.js'

export const GAMES = {
  gs: { biz: 'hk4e_cn', host: 'https://hk4e-api.mihoyo.com', name: '原神', source: 'genshin', official: '75276539', gid: 2 },
  sr: { biz: 'hkrpg_cn', host: 'https://public-operation-hkrpg.mihoyo.com', name: '星铁', source: 'hsr', official: '80823548', gid: 6 },
  zzz: { biz: 'nap_cn', host: 'https://public-operation-nap.mihoyo.com', name: '绝区零', source: 'zzz', official: '152039148', gid: 8 },
}

/** 兑换码状态保留 7 天：足够覆盖一个版本的码，又不会把 redis 撑大 */
export const SEEN_TTL = 7 * 24 * 3600

/** 这些返回码代表「这个号对这个码已经有结论」，不必再试 */
export const TERMINAL = new Set([0, -2001, -2003, -2017, -2018])

/** 常驻码（新手礼包之类）不进「近期收录」列表，否则每次都被当成新码兑一遍 */
const PERMANENT_CODES = new Set(['GENSHINGIFT', 'STARRAILGIFT', 'ZENLESSGIFT'])

/** 国服码：中文（原神/星铁现状）或英文数字（旧码与国际服） */
const CODE_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{2,64}$/

export const MESSAGES = {
  0: '兑换成功，奖励请到游戏内邮箱领取',
  '-2001': '兑换码已过期',
  '-2003': '无效的兑换码',
  '-2016': '兑换冷却中，请稍后再试',
  '-2017': '该兑换码已被使用',
  '-2018': '该兑换码已被使用',
  '-1071': '请发送 #扫码登录 后再试',
  '-1033': '请发送 #扫码登录 后再试',
  '-1035': '请稍后再试',
  '-100': '请发送 #扫码登录 后再试',
}

/**
 * #使用兑换码 / *使用兑换码 / %使用兑换码
 * #原神使用兑换码 …（TRSS loader 会把 *x/%x 改写成 #星铁x/#绝区零x，见项目 AGENTS.md）
 */
export const COMMAND_REG = '^\\s*([#*%])(?:(原神|星铁|绝区零))?(使用兑换码|兑换码使用|自动兑换码)([\\s\\S]*)$'

export function parseCommand(msg) {
  const m = String(msg || '').match(new RegExp(COMMAND_REG))
  if (!m) return null
  const game = ({ 原神: 'gs', 星铁: 'sr', 绝区零: 'zzz' })[m[2]] || ({ '#': 'gs', '*': 'sr', '%': 'zzz' })[m[1]]
  const arg = m[4].trim()
  if (m[3] === '自动兑换码') {
    const action = !arg || arg === '开启' ? 'on' : arg === '关闭' ? 'off' : arg === '状态' ? 'status' : 'usage'
    return { game, action }
  }
  const codes = arg ? [...new Set(arg.toUpperCase().split(/[\s,，;；]+/))] : null
  if (codes && (codes.length > 20 || codes.some(c => !CODE_RE.test(c)))) return { game, action: 'usage' }
  return { game, action: 'redeem', codes }
}

/** 统一请求：20 秒超时，非 2xx 与结构异常都抛错，调用方决定兜底 */
export async function requestJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await mysReq(url, { ...options, signal: controller.signal })
    if (!res?.ok) throw new Error(`HTTP ${res?.status}`)
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('接口返回格式异常')
    return data
  } finally {
    clearTimeout(timer)
  }
}

function check(data) {
  if (data.retcode !== 0) throw new Error(`接口返回 retcode=${data.retcode}`)
  return data.data
}

/** 只要最近 7 天内新增的码：更早的基本都过期了，还占冷却 */
function recent(time, now) {
  const t = Number(time)
  return Number.isFinite(t) && t > 0 && t <= now + 300 && t >= now - SEEN_TTL
}

export function normalizeCodes(rows, now = Math.floor(Date.now() / 1000)) {
  const codes = new Map()
  for (const row of rows || []) {
    const code = String(row?.code || '').trim().toUpperCase()
    if (!CODE_RE.test(code) || PERMANENT_CODES.has(code) || !recent(row.added_at, now)) continue
    if (!codes.has(code)) codes.set(code, { code, added_at: Number(row.added_at) })
  }
  return [...codes.values()]
}

const cache = new Map()

function cached(key, fn) {
  const old = cache.get(key)
  if (old && old.until > Date.now()) return old.promise
  const entry = { until: Date.now() + 5 * 60000 }
  entry.promise = fn().catch(err => {
    if (cache.get(key) === entry) cache.delete(key)
    throw err
  })
  cache.set(key, entry)
  return entry.promise
}

/**
 * 官方前瞻直播码：先找官方号最近的前瞻帖里的 act_id，
 * 找不到再从米游社首页导航兜底，最后查 miyolive 是否开播（remain>0 表示还没放码）。
 */
async function official(game) {
  const g = GAMES[game]
  const posts = check(await requestJson(`https://bbs-api.mihoyo.com/painter/api/user_instant/list?offset=0&size=20&uid=${g.official}`))
  if (!Array.isArray(posts?.list)) throw new Error('官方帖子结构异常')
  const now = Math.floor(Date.now() / 1000)
  let act = ''
  let created = 0
  for (const item of posts.list) {
    const post = item?.post?.post
    if (!recent(post?.created_at, now)) continue
    const id = String(post.structured_content || '').match(/act_id=([a-zA-Z0-9]+)/)?.[1]
    if (id && Number(post.created_at) > created) {
      act = id
      created = Number(post.created_at)
    }
  }
  if (!act) {
    const nav = check(await requestJson(`https://bbs-api.miyoushe.com/apihub/api/home/new?gids=${g.gid}&parts=1%2C3%2C4`))
    const item = nav?.navigator?.find(x => /前瞻|特别节目/.test(x.name || '') && /act_id=/.test(x.app_path || ''))
    act = item?.app_path?.match(/act_id=([a-zA-Z0-9]+)/)?.[1]
  }
  if (!act) return []
  const headers = { 'x-rpc-act_id': act }
  const live = check(await requestJson('https://api-takumi.mihoyo.com/event/miyolive/index', { headers }))?.live
  if (!live) throw new Error('官方直播结构异常')
  if (Number(live.remain) > 0) return []
  const q = new URLSearchParams({ version: String(live.code_ver), time: String(now) })
  const data = check(await requestJson(`https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode?${q}`, { headers }))
  if (!Array.isArray(data?.code_list)) throw new Error('官方码表结构异常')
  return normalizeCodes(data.code_list.map(x => ({ code: x.code, added_at: Number(x.to_get_time) || created })), now)
}

/** 自动兑换只允许官方前瞻源；独立缓存，不回退社区或手动取码结果。 */
export async function getAutoCodes(game) {
  return cached('auto-live:' + game, () => official(game))
}

export async function getCodes(game) {
  return cached(`codes:${game}`, async () => {
    let rows
    try {
      rows = await official(game)
    } catch (err) {
      globalThis.logger?.warn?.(`[xhh][兑换码] ${game}/官方码源失败: ${err.message}`)
      throw err
    }
    return normalizeCodes(rows)
  })
}

/** 用 ck 查该账号在这款游戏下的角色（兑换要 region + game_uid） */
export async function getRoles(game, ck) {
  const data = await requestJson(`https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=${GAMES[game].biz}`, { headers: { Cookie: ck } })
  if (data.retcode !== 0) return { retcode: data.retcode, roles: [] }
  if (!Array.isArray(data.data?.list)) throw new Error('绑定角色结构异常')
  return { retcode: 0, roles: data.data.list.filter(r => r.game_biz === GAMES[game].biz && r.game_uid && r.region) }
}

/**
 * 兑换单个码。webExchangeCdkey 只认 Cookie，不需要 DS 签名（与上游一致），
 * 所以这里保持 TL 的极简请求，没有额外拼 app 端签名。
 */
export async function redeemCode(game, role, ck, code) {
  const g = GAMES[game]
  const q = new URLSearchParams({ uid: String(role.game_uid), region: role.region, cdkey: code, game_biz: g.biz, lang: 'zh-cn' })
  const data = await requestJson(`${g.host}/common/apicdkey/api/webExchangeCdkey?${q}`, {
    headers: { Cookie: ck, Referer: 'https://webstatic.mihoyo.com/' },
  })
  if (typeof data.retcode !== 'number') throw new Error('兑换结果缺少 retcode')
  globalThis.logger?.info?.(`[xhh][兑换码] ${game}/${role.game_uid}/${code} retcode=${data.retcode} message=${String(data.message || '').slice(0, 200)}`)
  return { retcode: data.retcode, msg: MESSAGES[data.retcode] || '兑换失败，请稍后再试' }
}
