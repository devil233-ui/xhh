/**
 * stoken → 完整 ck 的内部兑换（裁剪自 xhh-TL 的 utils/auth.js，供 ck 失效自愈复用）
 *
 * 只保留 refreshCk 需要的最小集合：cookiePart / makeAppDs / stokenToCookie /
 * findStokenEntry / refreshCk。TL 的 userBind（绑定体系）、deletedCk（删除对账）
 * 等重依赖未随移植。
 *
 * ⚠️ 不能用 xhh 自带的 system/mhy.js refresh_cookies 做这件事：那是 v1 老逻辑
 * （stoken 直拼 URL、不带 mid），对 v2_ 开头的 stoken 会直接 -100 登录失效。
 * 这里按 TL 的实现带 mid + app 端 DS 签名，两个兑换接口都要带 uid + mid。
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

function makeAppDs(query = '') {
  const salt = 'rtvTthKxEyreVXQCnhluFgLXPOFKPHlA'
  const t = Math.floor(Date.now() / 1000)
  const r = Math.random().toString(36).slice(2, 8)
  const Ds = md5(`salt=${salt}&t=${t}&r=${r}&b=&q=${query}`)
  return `${t},${r},${Ds}`
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
 * 两个兑换接口都带 uid + mid（v2 stoken 缺 mid 会 -100），DS 的 q 与 URL query 一致。
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
    const headers = {
      Cookie: baseCk,
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Mi 10 Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.186 Mobile Safari/537.36 miHoYoBBS/2.71.1',
      'x-rpc-app_version': '2.71.1',
      'x-rpc-client_type': '2',
      'x-rpc-sys_version': '13',
      'x-rpc-channel': 'miyousheluodi',
      'x-rpc-device_id': crypto.randomUUID(),
      DS: makeAppDs(),
    }
    const midParam = mid ? `&mid=${encodeURIComponent(mid)}` : ''
    const authQuery = `stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}${midParam}`
    const cookieRes = await fetch(
      `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?${authQuery}`,
      { method: 'GET', headers: { ...headers, DS: makeAppDs(authQuery) }, signal: AbortSignal.timeout(12000) },
    ).then(r => r.json())
    const ltokenRes = await fetch(`https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken?${authQuery}`, {
      method: 'GET',
      headers: { ...headers, DS: makeAppDs(authQuery) },
      signal: AbortSignal.timeout(12000),
    }).then(r => r.json())

    const cookieToken = cookieRes?.data?.cookie_token
    const ltoken = ltokenRes?.data?.ltoken || entry.ltoken
    if (cookieToken && ltoken) {
      return `ltoken=${ltoken};ltuid=${stuid};cookie_token=${cookieToken};account_id=${stuid};`
    }
    if (cookieToken) {
      return `stuid=${stuid};stoken=${stoken};cookie_token=${cookieToken};account_id=${stuid};`
    }
    if (typeof logger !== 'undefined') {
      logger.debug?.(`[xhh][ckRefresh] stoken→ck ret cookie=${cookieRes?.retcode} ltoken=${ltokenRes?.retcode}`)
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

export default { cookiePart, stokenToCookie, findStokenEntry, refreshCk }
