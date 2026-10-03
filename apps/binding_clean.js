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
}
