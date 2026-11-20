import mysReq from './mysReq.js';
/**
 * stoken → 完整 ck 的内部兑换（供兑换码补凭证、ck 失效自愈、#刷新ck 共用）
 *
 * 兑换实现分两路，主路认 passport-api 的会话交换，老接口只作兜底：
 *   · 主路 `ma-cn-session/app/exchange`（app 端会话交换）：body 送 src_token(stoken) + mid +
 *     dst_token_type，`4` 换 cookie_token、`2` 换 ltoken；mid 必填，缺了直接 -3001 参数不合法。
 *   · 兜底 `account/auth/api/getCookieAccountInfoBySToken` / `getLTokenBySToken`：这两条老接口
 *     对这条 stoken 已基本关闭（实测恒回 -464 / 1002，换头组、换 app_version、换出口 IP 都不变），
 *     只在主路失败时试一次，留作兼容。
 * 头组用 app 端 pass 组（含 DS2，盐 passSalt），Cookie 传通行证三件套（stuid / stoken / mid）。
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import md5 from 'md5'
import YAML from 'yaml'

/** stoken yaml 候选目录（相对 Yunzai 根），与 xhh/xiaoyao 的存储保持一致 */
const STOKEN_DIRS = ['plugins/xhh/data/Stoken', 'plugins/xiaoyao-cvs-plugin/data/yaml']

export function cookiePart(ck = '', key) {
  const m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
  return m ? m[1] : ''
}

function readYaml(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {}
    }
  } catch (_) {}
  return {}
}

// ── 凭据换取（stoken → cookie_token / ltoken） ─────────────────────────────
const PASS_API = 'https://passport-api.mihoyo.com'
const PASS_SALT = 'JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS'
const PASS_APP_VERSION = '2.112.0'
const PASS_APP_ID = 'bll8iq97cem8'
// 本机 warp-http-bridge.service 把 WARP 的 SOCKS5 桥成 HTTP CONNECT，监听 8118
const WARP_PROXY = process.env.XHH_WARP_PROXY || 'http://127.0.0.1:8118'
// 直连被判出口风控时换 WARP 出口重试一次，不做业务重试链
const RISK_RETCODES = new Set([-464, 1002, -100, 1034, 5003, -501002, 10041])

function passDs(q = '', b = '') {
  const t = Math.floor(Date.now() / 1000)
  const r = Math.floor(100001 + Math.random() * 99999)
  return `${t},${r},${md5(`salt=${PASS_SALT}&t=${t}&r=${r}&b=${b}&q=${q}`)}`
}

// 设备身份必须**全进程稳定**：上游把 DEVICE_ID / DEVICE_NAME / DEVICE_MODEL 都提到模块级常量，
// 扫码的 create 与 query 两次请求要落在同一台"设备"上，否则 query 直接回 -3503
// （实测：每次请求重新随机 device_id，WARP 换出口也一样 -3503，判定为设备维度风险控制）。
const DEVICE_ID = crypto.randomBytes(16).toString('hex').toUpperCase()
const DEVICE_NAME = crypto.randomBytes(4).toString('hex')
const DEVICE_MODEL = crypto.randomBytes(8).toString('hex')

/**
 * app 端 pass 头组（上游 types:"pass"）：换票、扫码二维码两端点共用；
 * cookie 传通行证三件套或空串。
 */
export function passRequestHeaders(cookie = '') {
  return {
    'x-rpc-device_id': DEVICE_ID,
    'x-rpc-app_id': PASS_APP_ID,
    'x-rpc-device_name': DEVICE_NAME,
    'x-rpc-device_fp': '38d7ee0e96649',
    'x-rpc-device_model': DEVICE_MODEL,
    'x-rpc-app_version': PASS_APP_VERSION,
    'x-rpc-game_biz': 'bbs_cn',
    'x-rpc-sys_version': '11',
    'x-rpc-aigis': '',
    'Content-Type': 'application/json;',
    'x-rpc-client_type': '2',
    'x-rpc-sdk_version': '1.3.1.2',
    'User-Agent': 'okhttp/4.8.0',
    'Connection': 'Keep-Alive',
    'x-rpc-channel': 'appstore',
    'Accept': 'application/json',
    'Cookie': cookie,
    'DS': passDs('', ''),
  }
}

/**
 * 通行证接口统一出口：method/body 由调用方给，viaWarp 时走本机 WARP 桥。
 * 失败一律折成 {retcode:'NETWORK'|'PARSE'} 返回，不抛异常——换票是尽力而为的补票。
 */
async function passRequest(url, { method = 'GET', headers, body, viaWarp = false } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (!viaWarp) {
    return await mysReq(url, { method, headers, body: payload, signal: AbortSignal.timeout(12000) })
      .then((r) => r.json())
      .catch((err) => ({ retcode: 'NETWORK', message: err?.message || String(err) }))
  }
  const [{ HttpsProxyAgent }, https] = await Promise.all([
    import('https-proxy-agent'),
    import('node:https'),
  ])
  const agent = new HttpsProxyAgent(WARP_PROXY)
  return await new Promise((resolve) => {
    const req = https.request(url, { method, headers, agent, timeout: 15000 }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (buf += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf))
        } catch {
          resolve({ retcode: 'PARSE', message: buf.slice(0, 120) })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('WARP 请求超时')))
    req.on('error', (err) => resolve({ retcode: 'NETWORK', message: err?.message || String(err) }))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 直连被判风控时换 WARP 出口重试一次，仍不做业务重试链 */
async function passCall(url, opts) {
  const res = await passRequest(url, opts)
  if (!RISK_RETCODES.has(res?.retcode)) return res
  const viaWarp = await passRequest(url, { ...opts, viaWarp: true })
  if (typeof logger !== 'undefined' && !RISK_RETCODES.has(viaWarp?.retcode)) {
    logger.mark(
      `[xhh][ckRefresh] ${url.split('/').pop()} 直连被判风控(${res.retcode})，改走 WARP 出口 retcode=${viaWarp?.retcode}`,
    )
  }
  return viaWarp
}

/** 把 stoken 的两种存法（裸 stoken / `stuid=..;stoken=..;mid=..;`）统一拆成三件套 */
export function parseStokenParts(raw = '') {
  const s = String(raw || '').trim()
  const cookieForm = /(?:^|[;&])\s*(?:stoken|stuid|mid)=/.test(s)
  return {
    stuid: cookiePart(s, 'stuid') || cookiePart(s, 'ltuid') || cookiePart(s, 'account_id'),
    stoken: cookieForm ? cookiePart(s, 'stoken') : s.replace(/^stoken=/, ''),
    mid: cookiePart(s, 'mid'),
  }
}

/**
 * 用通行证三件套换 cookie_token 与 ltoken。
 * 主路：会话交换（dst 4 → cookie_token，dst 2 → ltoken，mid 必填）；
 * 主路失败再试老接口一次，仍失败时 retcode 报主路的值（老接口的 -464/1002 已经不说明问题）。
 * @returns {Promise<{cookieToken:string, ltoken:string, retcodes:object}>}
 */
export async function exchangeStoken({ stuid, stoken, mid } = {}) {
  const out = { cookieToken: '', ltoken: '', retcodes: {} }
  if (!stuid || !stoken) return out
  const cookie = `stuid=${stuid};stoken=${stoken};${mid ? `mid=${mid};` : ''}`
  const headers = passRequestHeaders(cookie)
  const jobs = [
    ['cookieToken', 4, 'getCookieAccountInfoBySToken'],
    ['ltoken', 2, 'getLTokenBySToken'],
  ]
  for (const [key, dst, legacyApi] of jobs) {
    let token = ''
    let code
    if (mid) {
      const res = await passCall(`${PASS_API}/account/ma-cn-session/app/exchange`, {
        method: 'POST',
        headers,
        body: { src_token: { token: stoken, token_type: 1 }, mid, dst_token_type: dst },
      })
      code = res?.retcode
      token = res?.data?.token?.token || ''
    }
    if (!token) {
      const legacy = await passCall(`${PASS_API}/account/auth/api/${legacyApi}`, {
        method: 'GET',
        headers,
      })
      const legacyToken =
        key === 'cookieToken'
          ? legacy?.data?.cookie_token || ''
          : legacy?.data?.ltoken || legacy?.data?.token?.token || ''
      if (legacyToken) {
        token = legacyToken
        code = legacy?.retcode
      } else if (code === undefined) {
        code = legacy?.retcode
      }
    }
    out.retcodes[key] = code
    if (key === 'cookieToken') out.cookieToken = token
    else out.ltoken = token
  }
  if (typeof logger !== 'undefined' && (!out.cookieToken || !out.ltoken)) {
    logger.warn(
      `[xhh][ckRefresh] 换票未拿全 cookie=${out.retcodes.cookieToken} ltoken=${out.retcodes.ltoken}${mid ? '' : '（缺 mid，只能走老接口）'}`,
    )
  }
  return out
}

function stokenCandidateFiles(qq) {
  const id = String(qq)
  return STOKEN_DIRS.map((dir) => path.join(process.cwd(), dir, `${id}.yaml`))
}

/** 按 stuid/ltuid 在 yaml（以 uid 为 key）里找对应条目；找不到返回 null */
export function findStokenEntry(qq, uid) {
  for (const file of stokenCandidateFiles(qq)) {
    if (!fs.existsSync(file)) continue
    const data = readYaml(file)
    if (!data || typeof data !== 'object') continue
    // 精确匹配该 uid 的条目；扫码绑定常见一个 stuid 挂多游戏 uid，遍历兜底
    const exact = data[uid] || data[String(uid)]
    if (exact && (exact.stoken || exact.ck_stoken)) return exact
    const sid = String(cookiePart(String(exact?.ck_stoken || ''), 'stuid') || uid)
    for (const v of Object.values(data)) {
      if (v && typeof v === 'object' && (v.stoken || v.ck_stoken)) {
        const entryStuid = String(
          v.stuid || v.ltuid || cookiePart(v.ck_stoken || '', 'stuid') || '',
        )
        if (entryStuid && entryStuid === sid) return v
      }
    }
  }
  return null
}

/**
 * 从 stoken 条目刷新 cookie_token / ltoken，得到完整 ck。
 * @returns {Promise<string>} 形如 ltoken=..;ltuid=..;cookie_token=..;account_id=..; 或兜底串
 */
export async function stokenToCookie(entry) {
  if (!entry) return ''
  if (entry.ck && /cookie_token/.test(entry.ck)) return entry.ck
  if (entry.cookie && /cookie_token/.test(entry.cookie)) return entry.cookie

  const stuid =
    entry.stuid ||
    cookiePart(entry.ck_stoken || '', 'stuid') ||
    cookiePart(entry.ck_stoken || '', 'ltuid')
  const stoken = entry.stoken || cookiePart(entry.ck_stoken || '', 'stoken')
  const mid = entry.mid || cookiePart(entry.ck_stoken || '', 'mid')
  if (!stuid || !stoken) {
    if (entry.ltoken && entry.cookie_token) {
      return `ltoken=${entry.ltoken};ltuid=${stuid || ''};cookie_token=${entry.cookie_token};account_id=${stuid || ''};`
    }
    return entry.ck || entry.ck_stoken || ''
  }

  const baseCk = mid ? `stuid=${stuid};stoken=${stoken};mid=${mid};` : `stuid=${stuid};stoken=${stoken};`

  try {
    const ex = await exchangeStoken({ stuid, stoken, mid })
    const ltoken = ex.ltoken || entry.ltoken
    if (ex.cookieToken && ltoken) {
      return `ltoken=${ltoken};ltuid=${stuid};cookie_token=${ex.cookieToken};account_id=${stuid};`
    }
    if (ex.cookieToken) {
      return `stuid=${stuid};stoken=${stoken};cookie_token=${ex.cookieToken};account_id=${stuid};`
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.debug?.(`[xhh][ckRefresh] stoken→ck failed: ${err?.message}`)
    }
  }

  if (entry.ltoken && entry.cookie_token) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};cookie_token=${entry.cookie_token};account_id=${stuid};`
  }
  if (entry.ltoken) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};account_id=${stuid};`
  }
  return entry.ck || entry.ck_stoken || baseCk
}

/**
 * 用 stoken 内部换一串新的完整 ck（供 ck 失效自愈复用）。
 * 只认真带 cookie_token 的结果，换不出统一返回 ''。
 * @returns {Promise<string>} 完整 ck 或 ''
 */
export async function refreshCk(qq, uid) {
  try {
    const entry = findStokenEntry(qq, uid)
    if (!entry) return ''
    const ck = await stokenToCookie(entry)
    return ck && /cookie_token=/.test(ck) ? ck : ''
  } catch (_) {
    return ''
  }
}

export default {
  cookiePart,
  passRequestHeaders,
  stokenToCookie,
  findStokenEntry,
  refreshCk,
  exchangeStoken,
  parseStokenParts,
}
