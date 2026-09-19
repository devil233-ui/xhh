/**
 * ck 失效自愈：全局运行时补丁（移植自 xhh-TL 的 utils/ckAutoRefresh.js）
 *
 * 背景：全云崽的米游社请求判「ck 失效」都收口在 genshin 官方插件的
 * MysInfo.prototype.checkCode——命中 [-1,-100,1001,10001,10103] 且 message 含
 * 「登录/login」时，会弹「UID:xxx，米游社Cookie已失效」并 delCk() 硬删凭证。
 *
 * 本补丁在 xhh 加载时包一层 checkCode：ck 失效那一刻，用 stoken 内部换出新 ck、
 * 换进当前 mysApi、写回 genshin 库、重发一次请求，用户全程无感。换不出（无 stoken /
 * stoken 也死）就原样交回 genshin 原逻辑，行为与打补丁前完全一致。
 *
 * 只 patch 一个方法、只在「自己的 ck 且交互请求」时介入，不碰 genshin 源码。
 */

import { refreshCk as realRefreshCk } from './ckRefresh.js'

const CK_DEAD_CODES = [-1, -100, 1001, 10001, 10103]
const PATCH_FLAG = '__xhhCkAutoRefresh'
// apiSync 批量接口里多个结果都用旧 ck 拉的，healing 第一个后循环里后续 sibling
// 仍 dead 会各自再调一次换 ck。短缓存让同一 qq:uid 在窗口内复用上次换好的 ck，
// 只让第一个 sibling 真打兑换接口——省接口调用、对米游社风控友好。
const CK_CACHE_TTL = 60 * 1000
const ckCache = new Map() // `${qq}:${uid}` -> { ck, at }

function isCkDead(res) {
  return !!res && CK_DEAD_CODES.includes(Number(res.retcode)) && /(登录|login)/i.test(res.message || '')
}

async function cachedRefreshCk(refreshFn, qq, uid) {
  const key = `${qq}:${uid}`
  const hit = ckCache.get(key)
  if (hit && Date.now() - hit.at < CK_CACHE_TTL) return hit.ck
  const ck = await refreshFn(qq, uid)
  if (ck) ckCache.set(key, { ck, at: Date.now() })
  return ck
}

/**
 * 把新 ck 写回 genshin 库，让下次请求不再失效。全程 try/catch，绝不抛：
 * 写回失败只是「这次换成功但没持久化」，不影响本次 swap+重发。
 * 每步做方法存在性检查，genshin 版本漂移不崩。
 */
async function writeBackCk(ckUser, newCk) {
  try {
    if (!ckUser || typeof ckUser.setCkData !== 'function') return
    ckUser.setCkData({ ck: newCk, device: ckUser.device })
    if (typeof ckUser.save === 'function') await ckUser.save()
    if (typeof ckUser.initCache === 'function') await ckUser.initCache()
  } catch (err) {
    logger?.debug?.(`[xhh][ckAutoRefresh] writeBack failed: ${err?.message}`)
  }
}

/**
 * 给 MysInfo 打补丁（依赖注入 refreshCk，便于脱机测试）。
 * @returns {boolean} 是否成功安装（已装过 / 无原型返回 false）
 */
export function installCkAutoRefresh(MysInfo, { refreshCk } = {}) {
  if (!MysInfo?.prototype || MysInfo.prototype[PATCH_FLAG]) return false
  const doRefresh = refreshCk || realRefreshCk
  const original = MysInfo.prototype.checkCode

  MysInfo.prototype.checkCode = async function (res, type, mysApi = {}, data = {}, isTask = false) {
    // 仅「交互请求 + 自己的 ck 失效 + 有可重发的 mysApi」才介入。
    // 公共 ck（ckInfo.uid 空）、定时任务（isTask）、其他 retcode 一律不碰。
    if (!isTask && isCkDead(res) && this.ckInfo?.uid && mysApi && typeof mysApi.getData === 'function') {
      try {
        const newCk = await cachedRefreshCk(doRefresh, this.userId, this.ckInfo.uid)
        if (newCk) {
          logger?.mark?.(`[xhh][ckAutoRefresh] 自动换 ck 重试 [uid:${this.ckInfo.uid}][qq:${this.userId}]`)
          mysApi.cookie = newCk // 换请求 ck（mysApi.getData 用 this.cookie）
          await writeBackCk(this.ckUser, newCk) // 持久化（best-effort，失败不阻塞）
          const retryRes = await mysApi.getData(type, data)
          // 重发结果交回*原始* checkCode 判：重发成功 → retcode 0 正常返回；
          // 重发仍失败 → 走 genshin 原生 delCk+提示（自然降级）。
          // 绝不再经过本包装层，杜绝二次换 ck / 死循环。
          return await original.call(this, retryRes, type, mysApi, data, isTask)
        }
      } catch (err) {
        logger?.debug?.(`[xhh][ckAutoRefresh] swap failed: ${err?.message}`)
        // 落到下面走原逻辑
      }
    }
    return await original.call(this, res, type, mysApi, data, isTask)
  }

  MysInfo.prototype[PATCH_FLAG] = true
  return true
}

// ---- 顶层 wiring：加载即执行一次；genshin 没装就静默跳过 ----
try {
  const mod = await import('../../genshin/model/mys/mysInfo.js')
  const MysInfo = mod?.default
  if (MysInfo && installCkAutoRefresh(MysInfo, { refreshCk: realRefreshCk })) {
    logger?.info?.('[xhh] ck 失效自愈补丁已装载')
  }
} catch (err) {
  logger?.debug?.(`[xhh][ckAutoRefresh] genshin 缺席，跳过: ${err?.message}`)
}

export default { installCkAutoRefresh }
