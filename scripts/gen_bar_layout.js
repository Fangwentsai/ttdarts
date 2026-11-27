#!/usr/bin/env node
/**
 * 產生 api/_lib/checkbox-layout.js（分紙上 30 個勝負長條的座標）。
 *
 * 座標必須從「列印版」量，不能從螢幕版量（SCORESHEET_OCR.md 發現 14：
 * 螢幕和 A4 列印的列高不同，會整體偏掉一個列高）。流程：
 *   1. 用 Chrome 把 pages/scoresheet.html 印成 A4 PDF
 *   2. PDF 轉成高解析度 PNG
 *   3. 跑跟照片完全相同的 deskew 校正
 *   4. 在校正後的畫布上找長條形的框（連通元件），依 y 排成 15 列、每列左右各一
 *
 * 用法：先在 ttdarts 根目錄起本機伺服器（python3 -m http.server 8897），再
 *   node scripts/gen_bar_layout.js [輸出 debug 圖的資料夾]
 * 分紙版面有任何改動，都要重跑這支。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { deskewScoresheet } = require('../api/_lib/deskew');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:8897/pages/scoresheet.html';
const SETS = 15;

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barlayout-'));
    const pdf = path.join(tmp, 'sheet.pdf');
    const png = path.join(tmp, 'sheet.png');
    execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, URL], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'png', '--resampleWidth', '2480', pdf, '--out', png], { stdio: 'ignore' });

    const desk = await deskewScoresheet(fs.readFileSync(png));
    if (!desk.applied) throw new Error('deskew 失敗：' + desk.reason);

    const { data, info } = await sharp(desk.buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = data[i] < 190 ? 1 : 0;

    // 連通元件：長條是空心框，框線本身就是一個連通元件，bbox 就是長條外框
    const seen = new Uint8Array(W * H);
    const boxes = [];
    for (let i = 0; i < W * H; i++) {
        if (!dark[i] || seen[i]) continue;
        let x1 = W, y1 = H, x2 = 0, y2 = 0, n = 0;
        const stack = [i]; seen[i] = 1;
        while (stack.length) {
            const p = stack.pop(), x = p % W, y = (p / W) | 0;
            n++; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
            for (const q of [p - 1, p + 1, p - W, p + W]) {
                if (q >= 0 && q < W * H && dark[q] && !seen[q] && Math.abs((q % W) - x) <= 1) { seen[q] = 1; stack.push(q); }
            }
        }
        const w = x2 - x1, h = y2 - y1;
        // 長條約 15mm x 5mm；畫布 1050px 寬對應約 200mm，約 5.2px/mm → 約 78 x 26
        if (w > 55 && w < 110 && h > 16 && h < 40 && w / h > 2 && w / h < 5) boxes.push({ x1, y1, x2, y2 });
    }

    const left = boxes.filter(b => b.x2 < W / 2).sort((a, b) => a.y1 - b.y1);
    const right = boxes.filter(b => b.x1 > W / 2).sort((a, b) => a.y1 - b.y1);
    if (left.length !== SETS || right.length !== SETS) {
        throw new Error(`預期左右各 ${SETS} 個長條，實際左 ${left.length}、右 ${right.length}`);
    }
    const layout = left.map((l, i) => ({ set: i + 1, winLeft: l, winRight: right[i] }));
    for (const row of layout) {
        if (Math.abs(row.winLeft.y1 - row.winRight.y1) > 12) throw new Error(`SET${row.set} 左右長條沒有對齊`);
    }

    // ---- 三黑統計表的格子 ----
    // 表格在最後一列長條下方：找黑底表頭（整列幾乎全黑的區段），表頭下緣到
    // 下方計分表之間平分成 AWARD_ROWS 列；直線用整段的暗像素比例找。
    const AWARD_ROWS = 8;
    const isDark = (x, y) => data[y * W + x] < 150;
    const lastBarY = layout[SETS - 1].winLeft.y2;
    let headTop = -1, headBottom = -1;
    for (let y = lastBarY + 20; y < H; y++) {
        let c = 0; for (let x = 0; x < W; x++) if (isDark(x, y)) c++;
        const full = c > W * 0.6;
        if (full && headTop < 0) headTop = y;
        if (headTop >= 0 && !full) {
            // 表格框線也是整列全黑，但只有 1~2px；表頭黑底至少 15px 才算
            if (y - headTop >= 15) { headBottom = y; break; }
            headTop = -1;
        }
    }
    if (headTop < 0) throw new Error('找不到三黑表表頭');
    const vlines = [];
    for (let x = 0; x < W; x++) {
        let c = 0; for (let y = headBottom + 5; y < headBottom + 200; y++) if (isDark(x, y)) c++;
        if (c > 170 && (!vlines.length || x - vlines[vlines.length - 1] > 4)) vlines.push(x);
    }
    // 預期 10 條直線（左表 5 條、右表 5 條），兩表中間的空隙會造成相鄰兩條，取每表各自的 5 條
    const leftV = vlines.filter(x => x < W / 2), rightV = vlines.filter(x => x > W / 2);
    if (leftV.length < 5 || rightV.length < 5) throw new Error(`三黑表直線數量不對：${vlines.join(',')}`);
    const L = leftV.slice(-5), R = rightV.slice(0, 5);
    // 列高：表頭下方的橫線間距取中位數（列分隔線跟表格下緣、下方計分表的框線
    // 長得一樣，不能直接找「下緣」那條線）
    const hlines = [];
    for (let y = headBottom + 3; y < headBottom + 260; y++) {
        let c = 0; for (let x = L[0]; x < L[4]; x++) if (isDark(x, y)) c++;
        if (c > (L[4] - L[0]) * 0.9 && (!hlines.length || y - hlines[hlines.length - 1] > 4)) hlines.push(y);
    }
    // 只取間距像「一列」的線（排除表頭下緣、計分表框線），用頭尾平均算列高，誤差不會逐列累積
    const step = hlines.slice(1).map((y, k) => y - hlines[k]).sort((a, b) => a - b)[1] || 0;
    const rowLines = hlines.filter((y, k) => k === 0 || Math.abs((y - hlines[k - 1]) - step) <= 3 || Math.abs((y - hlines[k - 1]) - 2 * step) <= 4);
    if (rowLines.length < 3) throw new Error('三黑表橫線太少：' + hlines.join(','));
    const nSteps = Math.round((rowLines[rowLines.length - 1] - rowLines[0]) / step);
    const exactStep = (rowLines[rowLines.length - 1] - rowLines[0]) / nSteps;
    const tableBottom = headBottom + exactStep * AWARD_ROWS;
    console.log('三黑表橫線', hlines.join(','), '列高', exactStep.toFixed(2));
    const rowH = (tableBottom - headBottom) / AWARD_ROWS;
    const cols = xs => ({ name: [xs[0], xs[1]], hat: [xs[1], xs[2]], wh: [xs[2], xs[3]], bed: [xs[3], xs[4]] });
    const awardLayout = {
        rowTop: headBottom, rowHeight: +rowH.toFixed(2), rows: AWARD_ROWS,
        home: cols(L), away: cols(R),
    };
    console.log('三黑表', JSON.stringify(awardLayout));

    const out = `/**
 * 分紙上 30 個勝負長條在校正後畫布（${W} x ${H}）上的座標。
 *
 * 由 scripts/gen_bar_layout.js 自動產生：把 pages/scoresheet.html 印成 A4、
 * 跑同一套 deskew 校正後偵測長條外框。不要手改，分紙版面改了就重跑。
 *
 * 每列兩個長條：winLeft＝主隊勝、winRight＝客隊勝。
 */

const CHECKBOX_LAYOUT = ${JSON.stringify(layout, null, 4)};

// 三黑統計表：每列高 rowHeight、從 rowTop 開始；各欄是 [左 x, 右 x]
const AWARD_LAYOUT = ${JSON.stringify(awardLayout, null, 4)};

module.exports = { CHECKBOX_LAYOUT, AWARD_LAYOUT };
`;
    fs.writeFileSync(path.join(__dirname, '../api/_lib/checkbox-layout.js'), out);
    console.log(`✅ 已寫入 ${SETS} 列座標；第一列`, layout[0], '最後一列 y', layout[SETS - 1].winLeft.y1);

    const dbg = process.argv[2];
    if (dbg) {
        const svg = `<svg width="${W}" height="${H}">${layout.flatMap(r => [r.winLeft, r.winRight]).map(b =>
            `<rect x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" fill="none" stroke="red" stroke-width="3"/>`).join('')}</svg>`;
        await sharp(desk.buffer).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dbg, 'layout_debug.png'));
        fs.writeFileSync(path.join(dbg, 'rectified_blank.jpg'), desk.buffer);
    }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
