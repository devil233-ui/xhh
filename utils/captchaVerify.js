/**
 * 米游社本地自动过码 —— 插件侧调用封装（裁剪自 xhh-TL 的 utils/mysVerify.js）
 *
 * 本地过码服务（独立 Python 进程：/root/geetest-solver/server.py，pm2 名 geetest-solver）
 * 自己完成「申请极验 → 解滑块 → 回交米游社清风险」全流程；本文件只负责把 cookie POST 过去。
 * TL 的手动过码链路（GT-Manual 式「@用户手划」）依赖其 mysClient，未随本文件移植；
 * 未配 auto_verify_addr 时由 captchaNotice 退回「发 #过码」提示。
 */

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
}

/** 本地自动过码：POST {cookie} → 服务跑全流程，返回是否成功 */
export async function solveByLocalService({ cookie, autoVerifyAddr }) {
  try {
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
      signal: AbortSignal.timeout(360000),
    }).then(r => r.json())
    if (res?.data?.result === 'ok') {
      log.mark(`[xhh][verify] 本地服务自动过码成功（第 ${res.data.round} 轮）`)
      return true
    }
    log.mark(`[xhh][verify] 本地服务未过码: ${JSON.stringify(res).slice(0, 120)}`)
    return false
  } catch (err) {
    log.error(`[xhh][verify] 本地服务不可用: ${err?.message}`)
    return false
  }
}

/** 批量自动过码：一次提交所有账号，服务端并发跑，返回与输入等长的结果数组 */
export async function solveBatchByLocalService(cookies, autoVerifyAddr) {
  const n = cookies.length
  if (!autoVerifyAddr || !n) return new Array(n).fill(false)
  try {
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
      signal: AbortSignal.timeout(600000),
    }).then(r => r.json())
    const results = res?.data?.results
    if (!Array.isArray(results)) {
      log.mark(`[xhh][verify] 批量过码返回异常: ${JSON.stringify(res).slice(0, 120)}`)
      return new Array(n).fill(false)
    }
    const okCount = results.filter(r => r?.ok).length
    log.mark(`[xhh][verify] 批量自动过码完成：${okCount}/${n} 成功`)
    return results.map(r => !!r?.ok)
  } catch (err) {
    log.error(`[xhh][verify] 批量过码服务不可用: ${err?.message}`)
    return new Array(n).fill(false)
  }
}
