#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe_goda_order_health.py —— 判断设备 DB 里每本 GoDa 漫画的章节顺序**是否还与站点一致**。

为什么需要它：**「顶行 chapter_number 最大」不是判据** —— 宿主 `getChapterList` 是
`chapter_number = i + 1`（在 `asReversed()` 之前按位置赋），所以 DB 里
「source_order 最小 ⇒ chapter_number 最大」是恒等式，顺序错了也照样成立。
真正有判别力的是**内容**：
    源交付「站点 order 升序」→ 宿主 asReversed() → 列表第 0 位 = 站点 order 最大的那一章。
因此 DB 里 source_order = 0 的 name **必须等于**站点 API 里 order 最大的 title；
末行也必须等于 order 最小的 title。

⚠️ source id 是 int64（-7781203140674704488），**JS 的 Number 存不下**（>2^53 会被四舍五入成
…704000，SQL 直接匹配不到）—— 所以这个探针必须是 Python。

用法：python probe_goda_order_health.py <tachiyomi.db 路径>
"""
import json
import re
import sqlite3
import sys
import urllib.request

DB = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dbpull/tachiyomi.db'
GODA_SOURCE = -7781203140674704488
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
    'Referer': 'https://godamh.com/',
}


def http_get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def extract_mid(html):
    """与 goda.js 一致的四层回退。"""
    for sel in ('bookmarkData', 'mangachapters'):
        m = re.search(r'id="%s"[^>]*data-mid="(\d+)"' % sel, html)
        if m:
            return m.group(1)
    m = re.search(r'data-mid\s*=\s*["\']?(\d+)', html)
    if m:
        return m.group(1)
    m = re.search(r'refs/(\d+)', html)
    return m.group(1) if m else None


def main():
    conn = sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
    cur = conn.cursor()
    rows = cur.execute(
        '''select m._id, m.title, m.url, m.author, m.initialized,
             (select count(*) from chapters c where c.manga_id = m._id) n
           from mangas m
           where m.source = ? and (select count(*) from chapters c where c.manga_id = m._id) > 0
           order by m._id''', (GODA_SOURCE,)).fetchall()

    print('GoDa 源下已入库章节的漫画：%d 本\n' % len(rows))
    bad = []
    for mid_db, title, url, author, initialized, n in rows:
        top = cur.execute(
            'select name, chapter_number from chapters where manga_id=? order by source_order asc limit 1',
            (mid_db,)).fetchone()
        bottom = cur.execute(
            'select name from chapters where manga_id=? order by source_order desc limit 1',
            (mid_db,)).fetchone()

        verdict, site_newest, site_oldest, mid = '?', '', '', None
        try:
            html = http_get('https://godamh.com' + url)
            mid = extract_mid(html)
            if not mid:
                verdict = '无法取 mid'
            else:
                payload = http_get(
                    'https://v2.apikk.top/api/v2/manga/get?mid=%s&mode=all' % mid)
                lst = json.loads(payload)['data']['chapters']
                site_oldest = lst[0]['attributes']['title']
                site_newest = lst[-1]['attributes']['title']
                verdict = 'OK' if (top[0] == site_newest and bottom[0] == site_oldest) \
                    else 'STALE(需重新同步)'
                if verdict != 'OK':
                    bad.append((mid_db, title))
        except Exception as e:                        # noqa: BLE001
            verdict = '抓取失败: %s' % e

        print('#%-5s %s  (%s 章, init=%s, mid=%s, author=%s)' %
              (mid_db, title, n, initialized, mid, author or '空'))
        print('   DB 顶行(source_order=0) : %s' % top[0])
        print('   站点最新章(应等于顶行)   : %s' % site_newest)
        print('   DB 末行                : %s' % bottom[0])
        print('   站点最旧章(应等于末行)   : %s' % site_oldest)
        print('   => %s\n' % verdict)

    print('=' * 72)
    if not bad:
        print('全部一致：DB 顺序与站点当前的「新→旧」完全吻合。')
    else:
        print('需要重新同步的漫画（%d 本）：' % len(bad))
        for i, t in bad:
            print('  #%s %s' % (i, t))
        print('\n修法：在这些漫画的详情页**下拉刷新**一次（= fetchAllFromSource(manual=true)），')
        print('      它同时刷新 info（作者/类型）与 chapters（source_order 按站点顺序重写）。')


if __name__ == '__main__':
    main()
