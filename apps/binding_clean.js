/**
 * 无效绑定体检与清理（仅主人）
 *
 * 移植自上游 v3 `apps/binding_clean.js`，按本地结构适配（probeCk / getGenshinCks 本地实现，
 * 没有走 #xhh 导出）。判据按来源分，因为可用性差别很大：
 *
 *  · genshin 插件的 CK（./data/db/data.db 的 MysUsers 表）—— 带 cookie_token，可以用
 *    getUserGameRolesByCookie 现场验活：这个接口只认 Cookie、不需要 DS，是目前唯一能可靠
 *    区分的探针。
 *  · 本插件与逍遥插件的条目 —— 它们的 ck_stoken 只有 stuid/stoken/mid，没有 cookie_token，
 *    探针无效，只能信社区签到接口的真实返回（system/sign.js 的 markInvalid 在签到时落盘）。
 *    踩过的坑：getCookieAccountInfoBySToken 与 getUserMissionsState 对当天签到成功的账号
 *    也一律回 -100，照它们判断会把全部绑定误删。
 *
 * 两个文件来源会删（删前另存 .bak 并回读校验）；genshin 那边是别的插件的数据，只报告不动。
 * 两步走：先体检（不动任何文件），确认后才删。
 */
import fs from 'node:fs';
import YAML from 'yaml';
import plugin from '../../../lib/plugins/plugin.js';
import mysReq from '../utils/mysReq.js';
// 绑定汇总（含游戏判据）与签到名单共用一份实现，避免两处常量各自演化
import { collectAll } from './sign_manage.js';
import { yaml, sleep, makeForwardMsg, pluginPriority, config } from '#xhh';

const INVALID_FILE = './plugins/xhh/data/invalid_stuid.json';
const GENSHIN_DB = './data/db/data.db';
const FILE_SOURCES = [
    { tag: '小花火', dir: './plugins/xhh/data/Stoken' },
    { tag: '逍遥', dir: './plugins/xiaoyao-cvs-plugin/data/yaml' },
];

const maskStuid = s => '****' + String(s).slice(-4);

function readInvalid() {
    if (!fs.existsSync(INVALID_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(INVALID_FILE, 'utf8')) || {};
    } catch {
        return {};
    }
}

function groupByPerson(hits) {
    const by = new Map();
    for (const h of hits) {
        const k = `${h.tag}|${h.qq}`;
        if (!by.has(k)) by.set(k, { tag: h.tag, qq: h.qq, items: [] });
        by.get(k).items.push(h);
    }
    return [...by.values()];
}

function describePerson(g) {
    const lines = [`来源：${g.tag}　QQ ${g.qq}`];
    for (const it of g.items) lines.push(`  通行证 ${maskStuid(it.stuid)}　${it.note}`);
    return lines.join('\n');
}

/** 把两个文件来源摊平成条目 */
function collectFileEntries() {
    const items = [];
    for (const { tag, dir } of FILE_SOURCES) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.yaml')) continue;
            const file = `${dir}/${f}`;
            let data;
            try {
                data = yaml.get(file);
            } catch {
                continue;
            }
            if (!data || typeof data !== 'object') continue;
            const qq = f.slice(0, -5);
            for (const key of Object.keys(data)) {
                const entry = data[key];
                if (!entry || typeof entry !== 'object' || !entry.stoken) continue;
                const stuid = String(entry.stuid || key);
                items.push({ tag, file, qq, key, stuid, ck: entry.ck_stoken || '' });
            }
        }
    }
    return items;
}

/** genshin 侧 CK 读取（只读打开 SQLite，避免动到别的插件的数据） */
async function getGenshinCks() {
    try {
        if (!fs.existsSync(GENSHIN_DB)) return [];
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(GENSHIN_DB, { readOnly: true });
        try {
            const rows = db.prepare("select ltuid, ck, uids from MysUsers where ck is not null and ck != ''").all();
            return rows
                .map(r => ({
                    ltuid: String(r.ltuid || ''),
                    ck: String(r.ck || ''),
                    uids: (() => {
                        try {
                            return JSON.parse(r.uids || '{}');
                        } catch {
                            return {};
                        }
                    })(),
                }))
                .filter(r => r.ltuid && /cookie_token=/.test(r.ck));
        } finally {
            db.close();
        }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][genshin_ck] 读取失败: ${err.message}`);
        return [];
    }
}

/** 探 CK 是否还有效：只认 Cookie、不需要 DS 的那个接口 */
async function probeCk(ck) {
    if (!ck || !/cookie_token=/.test(ck)) return { state: 'unknown', retcode: null };
    try {
        const res = await mysReq('https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn', {
            method: 'GET',
            headers: { Cookie: ck },
        }).then(r => r.json());
        const rc = Number(res?.retcode);
        if (rc === 0) return { state: 'ok', retcode: 0, roles: (res?.data?.list || []).length };
        if ([-100, -101, 10001].includes(rc)) return { state: 'invalid', retcode: rc };
        return { state: 'unknown', retcode: rc, message: String(res?.message || '').slice(0, 40) };
    } catch (err) {
        return { state: 'unknown', retcode: null, message: err.message };
    }
}

/** genshin 侧的 CK 现场验活，并发 4 */
async function probeGenshin() {
    const cks = await getGenshinCks();
    const out = [];
    let i = 0;
    const worker = async () => {
        while (i < cks.length) {
            const c = cks[i++];
            const r = await probeCk(c.ck);
            out.push({ ltuid: c.ltuid, ...r });
            await sleep(300);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
}

/**
 * 删掉若干顶层键并返回真实删掉的个数。
 * 不能用 yaml.set —— 它的第二个参数是点分字符串路径，传对象会在内部 keyname.split 处抛错、
 * 被内部 catch 掉再 return false，文件根本没写，而调用方不看返回值就会误报成功。
 * yaml.del 也不行，它只能删数组里的成员。这里用 parseDocument 删顶层键，顺带保留注释与排版。
 */
function deleteTopKeys(file, keys) {
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    let n = 0;
    for (const k of keys) {
        if (doc.has(k)) {
            doc.delete(k);
            n++;
        }
    }
    if (n) fs.writeFileSync(file, doc.toString());
    return n;
}

/** 文件来源只信签到留档；带 cookie_token 的条目额外用探针确认一次（探针优先） */
function judgeFiles(items, invalid) {
    const hits = [];
    const unknown = [];
    for (const it of items) {
        if (/cookie_token=/.test(it.ck)) {
            // 以后若补上了 cookie_token，这里可以走探针；当前数据都走不到
            it.note = '待探针确认';
            unknown.push(it);
            continue;
        }
        const rec = invalid[it.stuid];
        if (rec) hits.push({ ...it, note: `签到判失效于 ${rec.last || '未知'}` });
    }
    return { hits, unknown };
}

/** Bot 是全局，稳妥起见按仓库惯例兜底 */
const getBot = () => globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null);

// 重入锁放模块级：Yunzai 每条消息都会 new 一个插件实例，实例字段存不住
let orphanRunning = false;

/**
 * 所有 bot 实例（多 bot 时逐个都算）。主 Bot 与 Bot.bots 里可能重复，按对象引用去重。
 */
function allBots() {
    const bots = [];
    const seen = new Set();
    const push = b => {
        if (!b || !b.gl || seen.has(b)) return;
        seen.add(b);
        bots.push(b);
    };
    push(getBot());
    for (const b of Object.values(getBot()?.bots || {})) push(b);
    return bots;
}

/**
 * 所有 bot 所在群的并集：gid -> group 对象（拿不到对象就存 null，后面靠 pickGroup 补）。
 *
 * 注意：ICQQ 系适配器启动时会把 Bot.gl 填满，但 **OneBot/NapCat 下 gl 常常是空的**
 * （实测本机 OneBotv11 上 allGroups() 返回 0 个群 —— 那样所有绑定者都会被当成
 * 「不在任何群」，非常危险）。所以这里分三层：gl → 适配器的 getGroupList/getGroupMap
 * → sendApi('get_group_list')。任一层的键都可能是 `${uin}-${gid}` 或纯 gid，统一取尾部数字。
 */
async function allGroups() {
    const map = new Map();
    const add = (key, group) => {
        const digits = String(key).match(/(\d{5,12})/g);
        const gid = digits ? digits[digits.length - 1] : '';
        if (!gid) return;
        if (!map.has(gid)) map.set(gid, group || null);
        else if (!map.get(gid) && group) map.set(gid, group);
    };
    for (const b of allBots()) for (const [gid, group] of b.gl || new Map()) add(gid, group);

    if (!map.size) {
        for (const b of allBots()) {
            try {
                const gl = b.getGroupMap?.() || b.getGroupList?.();
                for (const [gid, group] of gl || new Map()) add(gid, group);
            } catch {
                /* 换下一层 */
            }
        }
    }
    if (!map.size) {
        for (const b of allBots()) {
            try {
                const res = await b.sendApi?.('get_group_list', {});
                for (const g of res?.data || res || []) {
                    const gid = g?.group_id ?? g?.groupId ?? g?.id ?? g;
                    if (gid) {
                        let group = null;
                        try {
                            group = b.pickGroup?.(Number(gid)) || null;
                        } catch {
                            /* 没对象就按 gid 走 sendApi */
                        }
                        add(gid, group);
                    }
                }
            } catch {
                /* 拉不到就算了，交由调用方报错 */
            }
        }
    }
    return map;
}

/** 该 gid 的 group 对象（拿不到就用 pickGroup 补一个） */
function groupOf(gid, group) {
    if (group) return group;
    for (const b of allBots()) {
        try {
            const g = b.pickGroup?.(Number(gid));
            if (g) return g;
        } catch {
            /* 试下一个 */
        }
    }
    return null;
}

/**
 * 收集「有 bot 在场的所有群」的成员 QQ 集合。
 * 一个群拉一次成员列表（而不是「每个用户 × 每个群」问一次），并发 3；
 * 群对象方法拿不到就退回 sendApi 实时拉。拉不到成员的群计入 failed，
 * 调用方必须如实说明 —— 否则那些群的成员会被当成「不在任何群」而误删。
 */
async function collectGroupMembers() {
    const list = [...(await allGroups()).entries()];
    const members = new Set();
    let ok = 0;
    let failed = 0;
    let i = 0;
    const worker = async () => {
        while (i < list.length) {
            const [gid, groupOrNull] = list[i++];
            const group = groupOf(gid, groupOrNull);
            let arr = [];
            try {
                if (group?.getMemberArray) arr = await group.getMemberArray();
                if (!arr?.length && group?.getMemberMap) arr = await group.getMemberMap(true);
                if (!arr?.length && group?.getMemberList) arr = await group.getMemberList();
            } catch {
                /* 换 sendApi */
            }
            if (!arr?.length) {
                try {
                    const bot = group?.bot || getBot();
                    const res = await bot?.sendApi?.('get_group_member_list', { group_id: Number(gid), no_cache: true });
                    arr = res?.data || res || [];
                } catch {
                    /* 拉不到就计数 */
                }
            }
            const qqs = (Array.isArray(arr) ? arr : [])
                .map(m => String(m?.user_id ?? m?.userId ?? m ?? '').trim())
                .filter(v => /^\d{5,12}$/.test(v));
            if (qqs.length) {
                ok++;
                qqs.forEach(q => members.add(q));
            } else {
                failed++;
            }
            await sleep(150);
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { members, groups: list.length, ok, failed };
}


export class BindingClean extends plugin {
    constructor(e) {
        super({
            name: '[小花火]清理无效绑定',
            dsc: '体检并清理已失效的米游社绑定（仅主人）',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [
                // 后缀只留本插件特有的词。genshin 那边的清理指令用的是「无效+账户/ck/记录」
                // 这套说法，别名带上会把那几条抢走（上游实测被抢过一次）。
                {
                    reg: '^#*(小花火|xhh)*(清理|清除|删除)(无效|失效|过期|无用)(绑定|账号|帐号)(列表|体检|检查)?$',
                    fnc: 'scan',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*(清理|清除|删除)(无效|失效|过期|无用)(绑定|账号|帐号)\\s*(确认|确定|yes|ok)?$',
                    fnc: 'clean',
                    permission: 'master',
                },

                // 离群绑定：绑了 CK/stoken，但不在任何「有 bot 在场的群」里
                {
                    reg: '^#*(小花火|xhh)*(清理|清除|删除)(离群|不在群|退群|离会)(绑定|账号|帐号|CK|ck)(列表|体检|检查)?$',
                    fnc: 'scanOrphan',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*(清理|清除|删除)(离群|不在群|退群|离会)(绑定|账号|帐号|CK|ck)\s*(确认|确定|yes|ok)?$',
                    fnc: 'cleanOrphan',
                    permission: 'master',
                },
            ],
        });
    }

    /** 体检：只列不动 */
    async scan(e) {
        const invalid = readInvalid();
        const items = collectFileEntries();
        const { hits, unknown } = judgeFiles(items, invalid);

        await e.reply('正在验活 genshin 侧的 CK，稍等…', true);
        const g = await probeGenshin();
        const gInvalid = g.filter(r => r.state === 'invalid');
        const gOk = g.filter(r => r.state === 'ok');

        const lines = [
            '体检完成（未改动任何文件）',
            `  本插件 + 逍遥：${items.length} 条，其中判失效 ${hits.length} 条`,
            `  genshin 侧：${g.length} 条 CK，有效 ${gOk.length}，失效 ${gInvalid.length}`,
        ];
        if (!hits.length) {
            lines.push('', '本插件两个来源暂时没有失效条目。');
            lines.push('  这里的失效结论来自社区签到的真实返回（-100/-101/10001），先正常签到一次才会有留档。');
        } else {
            const people = groupByPerson(hits);
            lines.push('', `失效条目（按人汇总，共 ${people.length} 人）：`);
            lines.push(...people.slice(0, 12).map(describePerson));
            if (people.length > 12) lines.push(`…还有 ${people.length - 12} 人`);
            lines.push('', '要清理请发「#清理无效绑定 确认」，删除前每个文件都会另存 .bak。');
        }
        if (unknown.length) lines.push('', `另有 ${unknown.length} 条待确认（补上 cookie_token 后可用探针判定）。`);
        if (gInvalid.length) {
            lines.push('', `genshin 侧失效 ${gInvalid.length} 条（${gInvalid.slice(0, 3).map(r => maskStuid(r.ltuid)).join('、')}${gInvalid.length > 3 ? ' 等' : ''}）：那是别的插件的数据，这里只报告，需要清理请用 genshin 自己的指令。`);
        }

        await e.reply(await makeForwardMsg(e, [lines.join('\n')], '无效绑定体检'), true);
        return true;
    }

    /** 清理：删本插件两个来源的失效条目（genshin 侧不动） */
    async clean(e) {
        if (!/确认|确定|yes|ok/i.test(e.msg)) return this.scan(e);
        const invalid = readInvalid();
        const { hits } = judgeFiles(collectFileEntries(), invalid);
        if (!hits.length) {
            return e.reply('没有可清理的条目，未改动任何文件。\n（失效结论来自签到留档，先正常签到一次才会有。）', true);
        }
        const byFile = new Map();
        for (const h of hits) {
            if (!byFile.has(h.file)) byFile.set(h.file, []);
            byFile.get(h.file).push(h);
        }
        const done = [];
        const failed = [];
        for (const [file, list] of byFile.entries()) {
            try {
                let data;
                try {
                    data = yaml.get(file);
                } catch {
                    data = null;
                }
                if (!data || typeof data !== 'object') {
                    failed.push(`${file}（读不出来，未动）`);
                    continue;
                }
                fs.writeFileSync(`${file}.bak`, fs.readFileSync(file));
                const keys = list.map(h => h.key).filter(k => k in data);
                deleteTopKeys(file, keys);
                // 回读校验：确认键真的没了才报数，否则如实说没删掉
                const after = yaml.get(file) || {};
                const still = keys.filter(k => k in after);
                if (still.length) failed.push(`${file}（${still.length} 条没删掉：${still.join('、')}）`);
                else done.push(`${file}　删除 ${keys.length} 条，剩 ${Object.keys(after).length} 条`);
            } catch (err) {
                failed.push(`${file}（${err.message}）`);
            }
        }
        // 把已删掉的失效记录同步移出留档
        try {
            const left = {};
            const still = new Set(collectFileEntries().map(r => r.stuid));
            for (const [k, v] of Object.entries(invalid)) if (still.has(k)) left[k] = v;
            fs.writeFileSync(INVALID_FILE, JSON.stringify(left, null, 2));
        } catch {
            /* 留档清理失败不影响删除结果 */
        }

        const lines = [done.length ? `已清理 ${hits.length} 条失效绑定，涉及 ${done.length} 个文件` : '没能删掉任何条目，文件均未改动'];
        lines.push(...done.map(x => '  · ' + x));
        if (failed.length) lines.push('未处理：', ...failed.map(x => '  · ' + x));
        lines.push('原文件都已另存 .bak，需要恢复就把 .bak 改回原名。');
        await e.reply(lines.join('\n'), true);
        return true;
    }

    /**
     * 离群绑定体检：绑定了 CK/stoken、但不在「任何有 bot 在场的群」里。
     * 群集合是**所有 bot 所在群的并集**（多 bot 时按并集算：只在其中一个 bot 的群里也算在群里）。
     * 只列不动。
     */
    async scanOrphan(e) {
        if (orphanRunning) return e.reply('上一次离群任务还在跑，稍等一下…', true);
        orphanRunning = true;
        try {
            await e.reply('正在收集各群成员（多 bot 取并集），群多时要等一会儿…', true);
            const { members, groups, ok, failed } = await collectGroupMembers();
            if (!groups || !members.size) {
                logger.error(`[xhh][离群] 群 ${groups} 个、成员 ${members.size} 人，无法判断离群，已中止（不动任何文件）`);
                return e.reply(
                    `没取到群或群成员（群 ${groups} 个，成员 ${members.size} 人），无法判断谁离群，已中止，未动任何文件。\n`
                        + '可能是适配器拿不到群列表（OneBot/NapCat 下 gl 常为空），请换个能取群列表的适配器再试。',
                    true,
                );
            }
            const all = collectAll();
            const orphan = all.filter(a => !members.has(String(a.qq)));
            const lines = [
                '离群绑定体检（未改动任何文件）',
                `  有 bot 在场的群：${groups} 个（成功取到成员 ${ok} 个，取不到 ${failed} 个）`,
                `  群成员去重后 ${members.size} 人；已绑定 CK/stoken 的 ${all.length} 人，其中不在任何群里的 ${orphan.length} 人`,
            ];
            if (failed) lines.push(`  ⚠️ 有 ${failed} 个群没取到成员，这些群的成员可能被误判成离群，请先确认。`);
            // 这是个重活（要把所有群的成员都拉一遍），结果记一行日志，事后能核对数字
            logger.mark(`[xhh][离群] 群 ${groups} 个（取到成员 ${ok} / 失败 ${failed}），群成员去重 ${members.size} 人，绑定 ${all.length} 人，离群 ${orphan.length} 人`);
            if (!orphan.length) {
                lines.push('', '没有离群绑定。');
            } else {
                lines.push('', '离群的人（来源 / 账号数 / stuid）：');
                for (const a of orphan.slice(0, 20)) {
                    const src = [a.fromXh && '小花火', a.fromXy && '逍遥'].filter(Boolean).join('+');
                    lines.push(`  QQ ${a.qq}　${src}　${a.accounts} 个账号　${[...a.stuids].slice(0, 3).map(maskStuid).join(' ')}`);
                }
                if (orphan.length > 20) lines.push(`  …还有 ${orphan.length - 20} 人`);
                lines.push('', '要清理请发「#清理离群绑定 确认」：会删掉这些人在小花火与逍遥两侧的绑定文件，各自另存 .bak。');
            }
            await e.reply(await makeForwardMsg(e, [lines.join('\n')], '离群绑定体检'), true);
            return true;
        } finally {
            orphanRunning = false;
        }
    }

    /** 离群绑定清理：删两个来源的整份绑定（该人的所有 CK/stoken），删前另存 .bak */
    async cleanOrphan(e) {
        if (!/确认|确定|yes|ok/i.test(e.msg)) return this.scanOrphan(e);
        if (orphanRunning) return e.reply('上一次离群任务还在跑，稍等一下…', true);
        orphanRunning = true;
        try {
            await e.reply('正在收集各群成员（多 bot 取并集），群多时要等一会儿…', true);
            const { members, groups, ok, failed } = await collectGroupMembers();
            if (!groups || !members.size) {
                logger.error(`[xhh][离群] 群 ${groups} 个、成员 ${members.size} 人，无法判断离群，已中止（未删任何文件）`);
                return e.reply(
                    `没取到群或群成员（群 ${groups} 个，成员 ${members.size} 人），无法判断谁离群，已中止，**未删任何文件**。\n`
                        + '可能是适配器拿不到群列表，请换个能取群列表的适配器再试。',
                    true,
                );
            }
            const orphan = collectAll().filter(a => !members.has(String(a.qq)));
            if (!orphan.length) return e.reply('没有离群绑定，未改动任何文件。', true);
            const done = [];
            const failedFiles = [];
            for (const a of orphan) {
                for (const { tag, dir } of FILE_SOURCES) {
                    const file = `${dir}/${a.qq}.yaml`;
                    if (!fs.existsSync(file)) continue;
                    try {
                        fs.writeFileSync(`${file}.bak`, fs.readFileSync(file));
                        fs.unlinkSync(file);
                        done.push(`${tag}　QQ ${a.qq}`);
                    } catch (err) {
                        failedFiles.push(`${tag}　QQ ${a.qq}（${err.message}）`);
                    }
                }
                try {
                    const invalid = readInvalid();
                    let hit = false;
                    for (const s2 of a.stuids) {
                        if (invalid[s2]) {
                            delete invalid[s2];
                            hit = true;
                        }
                    }
                    if (hit) fs.writeFileSync(INVALID_FILE, JSON.stringify(invalid, null, 2));
                } catch {
                    /* 留档清理失败不影响主体 */
                }
                await sleep(80);
            }
            const out = [
                `离群绑定清理完成：${orphan.length} 人`,
                `（群 ${groups} 个，取到成员 ${ok} 个${failed ? `，取不到 ${failed} 个` : ''}）`,
            ];
            out.push(...done.map(x => '  · 已删 ' + x));
            if (failedFiles.length) out.push('未处理：', ...failedFiles.map(x => '  · ' + x));
            out.push('原文件都已另存 .bak（同目录同名 + .bak），需要恢复就把 .bak 改回原名。');
            return e.reply(out.join('\n'), true);
        } finally {
            orphanRunning = false;
        }
    }

}
