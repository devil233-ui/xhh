#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 xhh-TL 模块仓拉取单个功能模块，解开后与本地仓库逐文件对照。

TL 把功能拆成 .xhmp 包——gzip 压缩的 JSON，内含该功能的完整文件集
（apps/ utils/ resources/ 三个顶层目录，与外层插件仓库同构）。
移植前用本工具看清两件事：这个功能由哪些文件组成；其中哪些我们已有
同名文件、且内容与 TL 的不同（那些必须人工合并，不能直接覆盖）。

用法：
    python3 tools/xhmp-pull.py --list                列出全部可安装模块
    python3 tools/xhmp-pull.py sr_gacha              拉取并对照
    python3 tools/xhmp-pull.py sr_gacha --repo PATH  指定对照的仓库根
    python3 tools/xhmp-pull.py sr_gacha --no-compare 只解包，不比对

本工具只读远端、只写 --out 目录（默认 /tmp/xhmp），不修改仓库任何文件。
"""

import argparse
import base64
import gzip
import hashlib
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

TL_REPO = 'cchanlan/xhh-TL'
MODULES_REPO = 'cchanlan/xhh-TL-modules'
RAW_BASE = 'https://raw.githubusercontent.com'
CATALOG_URL = f'{RAW_BASE}/{TL_REPO}/master/config/modules-catalog.json'
PACKAGE_BASE = f'{RAW_BASE}/{MODULES_REPO}/master/'

REPO_ROOT = Path(__file__).resolve().parent.parent


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'xhh-xhmp-pull/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def load_catalog(cache_dir, refresh=False):
    cache = cache_dir / 'catalog.json'
    if cache.exists() and not refresh:
        try:
            return json.loads(cache.read_text('utf-8'))
        except (OSError, ValueError):
            pass
    data = json.loads(fetch(CATALOG_URL).decode('utf-8'))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, ensure_ascii=False), 'utf-8')
    return data


def pick_module(catalog, want):
    for mod in catalog.get('modules') or []:
        if mod.get('id') == want:
            return mod
    return None


def safe_relpath(raw):
    """模块包内的路径一律当相对路径处理，拒绝绝对路径与 .. 穿越。"""
    text = str(raw or '').replace('\\', '/').lstrip('/')
    parts = [seg for seg in text.split('/') if seg not in ('', '.')]
    if not parts or any(seg == '..' for seg in parts):
        raise ValueError(f'模块包里有非法路径，已中止：{raw!r}')
    return '/'.join(parts)


def unpack(payload, target):
    """解开包内全部文件，返回 [(相对路径, 字节内容), ...]。"""
    written = []
    for item in payload.get('files') or []:
        rel = safe_relpath(item.get('path'))
        blob = base64.b64decode(item.get('content') or '')
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(blob)
        written.append((rel, blob))
    return written


def compare(written, repo):
    """与本地仓库同名文件比对，返回 [(状态, 相对路径, 包内大小, 本地大小)]。"""
    rows = []
    for rel, blob in written:
        local = repo / rel
        if not local.is_file():
            rows.append(('new', rel, len(blob), None))
            continue
        try:
            local_bytes = local.read_bytes()
        except OSError:
            rows.append(('unreadable', rel, len(blob), None))
            continue
        same = hashlib.sha256(local_bytes).hexdigest() == hashlib.sha256(blob).hexdigest()
        rows.append(('same' if same else 'diff', rel, len(blob), len(local_bytes)))
    return rows


def human(n):
    if n is None:
        return '-'
    if n < 1024:
        return f'{n} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.1f} KB'
    return f'{n / 1024 / 1024:.1f} MB'


MARK = {
    'new': '新增',
    'same': '相同',
    'diff': '冲突',
    'unreadable': '不可读',
}


def print_list(catalog):
    mods = [m for m in (catalog.get('modules') or []) if not m.get('internal')]
    print(f'TL 可安装模块共 {len(mods)} 个：\n')
    width = max((len(m.get('id') or '') for m in mods), default=8)
    for mod in sorted(mods, key=lambda m: m.get('id') or ''):
        mid = (mod.get('id') or '').ljust(width)
        label = mod.get('label') or ''
        ver = mod.get('version') or (mod.get('package') or '').split('/')[-1].replace('.xhmp', '')
        print(f'  {mid}  {label}  ({ver})')
    print('\n用法：python3 tools/xhmp-pull.py <模块id>')


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='拉取 xhh-TL 功能模块并与本地仓库逐文件对照（只读仓库，不写入）')
    parser.add_argument('module', nargs='?', help='模块 id，例如 sr_gacha')
    parser.add_argument('--list', action='store_true', help='列出全部可安装模块')
    parser.add_argument('--out', default='/tmp/xhmp', help='解包与缓存目录（默认 /tmp/xhmp）')
    parser.add_argument('--repo', default=str(REPO_ROOT), help='对照的仓库根目录（默认本插件根）')
    parser.add_argument('--no-compare', action='store_true', help='只解包，不与本地仓库比对')
    parser.add_argument('--refresh', action='store_true', help='强制重新拉取模块清单')
    args = parser.parse_args(argv)

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        catalog = load_catalog(out_dir, refresh=args.refresh)
    except (urllib.error.URLError, OSError, ValueError) as err:
        print(f'拉取模块清单失败：{err}', file=sys.stderr)
        return 1

    if args.list or not args.module:
        print_list(catalog)
        return 0

    mod = pick_module(catalog, args.module)
    if mod is None:
        print(f'模块清单里没有 {args.module}，先跑 --list 看看有哪些。', file=sys.stderr)
        return 1

    pkg_path = mod.get('package') or ''
    if not pkg_path:
        print(f'模块 {args.module} 没有 package 字段，无法下载。', file=sys.stderr)
        return 1

    label = mod.get('label') or ''
    version = mod.get('version') or pkg_path.split('/')[-1].replace('.xhmp', '')
    print(f'模块 {args.module}（{label}）版本 {version}')

    try:
        raw = fetch(PACKAGE_BASE + pkg_path)
    except (urllib.error.URLError, OSError) as err:
        print(f'下载模块包失败：{err}', file=sys.stderr)
        return 1

    expect = (mod.get('sha256') or '').lower()
    actual = hashlib.sha256(raw).hexdigest()
    digest = 'sha256 校验通过' if (not expect or expect == actual) else f'sha256 不符（期望 {expect[:12]}…，实际 {actual[:12]}…）'
    print(f'下载完成：{human(len(raw))}，{digest}')

    try:
        payload = json.loads(gzip.decompress(raw).decode('utf-8'))
    except (OSError, ValueError) as err:
        print(f'解压模块包失败（不是合法的 gzip json）：{err}', file=sys.stderr)
        return 1

    target = out_dir / args.module
    if target.exists():
        shutil.rmtree(target)
    try:
        written = unpack(payload, target)
    except (ValueError, OSError) as err:
        print(f'解包失败：{err}', file=sys.stderr)
        return 1
    print(f'已解开 {len(written)} 个文件到 {target}')

    if args.no_compare:
        for rel, blob in written:
            print(f'  {rel}  {human(len(blob))}')
        return 0

    repo = Path(args.repo).expanduser()
    if not repo.is_dir():
        print(f'对照目录不存在，跳过比对：{repo}', file=sys.stderr)
        return 0

    rows = compare(written, repo)
    counts = {}
    for state, _, _, _ in rows:
        counts[state] = counts.get(state, 0) + 1

    print(f'\n与 {repo} 逐文件对照：')
    width = max((len(r[1]) for r in rows), default=10)
    for state, rel, size, local_size in sorted(rows, key=lambda r: (r[0] != 'diff', r[1])):
        mark = MARK.get(state, state)
        line = f'  {mark}  {rel.ljust(width)}  {human(size)}'
        if state == 'diff':
            line += f'  （本地 {human(local_size)}，内容不同）'
        elif state == 'same':
            line += '  （与本地一致）'
        print(line)

    summary = '，'.join(f'{MARK[k]} {v} 个' for k, v in sorted(counts.items()))
    print(f'\n合计 {len(rows)} 个：{summary}')
    if counts.get('diff'):
        print('冲突文件说明我们改过同一份代码，移植时必须人工合并，别直接覆盖。')
    if counts.get('new') and not counts.get('diff'):
        print('全部是新增文件，可以按目录结构直接落位。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
