/**
 * 分紙塗黑框判讀（純影像處理，不經過語言模型）
 *
 * 先攻／勝負這兩類欄位的答案只有「左邊那格有墨跡，還是右邊那格」，
 * 是純粹的視覺量測，不需要理解任何語意。實測 Gemini 在這件事上很不可靠：
 * 正確率在多次重跑之間從 25% 到 75% 大幅跳動，最差的一次 16 局全部回傳
 * 同一個值（模型直接套一個固定答案而不是逐列判讀），而且信心分數不論
 * 對錯都固定落在 90~95，沒有任何鑑別力（見 SCORESHEET_OCR.md 發現 10~12）。
 *
 * 改用直接量墨水覆蓋率：在校正後的固定畫布上，每個方框的位置是已知的，
 * 量框內暗像素比例即可。同一張照片實測先攻 93.8%、勝負 87.5%，
 * 且結果完全可重現（不像呼叫模型每次都不一樣）。
 *
 * 姓名欄仍然交給 Gemini——那才是真正需要辨識能力的部分。
 */

const sharp = require('sharp');
const { CHECKBOX_LAYOUT, AWARD_LAYOUT } = require('./checkbox-layout');

// 框內取樣時四邊各往內縮的比例，避開方框本身的黑色邊框
const INSET = 0.18;
// 低於這個灰階值算「有墨跡」
const DARK_LEVEL = 170;
// 比紙色暗這麼多才算墨跡
const DARK_DROP = 55;
// 垂直對齊的搜尋範圍（見 findVerticalOffset 的說明）

/**
 * 判讀 16 局的先攻與勝負。
 * @param {Buffer} rectifiedBuffer 已經過 deskew 校正的分紙影像
 * @returns {Promise<{sets: Array, offset: number, applied: boolean, reason?: string}>}
 */
async function readCheckboxes(rectifiedBuffer) {
    try {
        const { data, info } = await sharp(rectifiedBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
        const img = { data, width: info.width, height: info.height };

        const sets = CHECKBOX_LAYOUT.map(row => {
            const left = locateBar(img, row.winLeft);
            const right = locateBar(img, row.winRight);
            const cov = { winLeft: coverage(img, left, 0), winRight: coverage(img, right, 0) };
            return { set: row.set, winner: decidePair(cov.winLeft, cov.winRight), coverage: cov, located: { left, right } };
        });

        // 三黑表跟主表格一起印在同一張紙上，用最後幾列長條實際找到的位移當作表格的位移
        const tail = sets.slice(-3);
        const shift = (key, k1) => tail.reduce((acc, r) => acc
            + (r.located.left[key] - CHECKBOX_LAYOUT[r.set - 1].winLeft[key])
            + (r.located.right[key] - CHECKBOX_LAYOUT[r.set - 1].winRight[key]), 0) / (tail.length * 2);
        const awards = readAwardCells(img, shift('x1'), shift('y1'));

        return { sets, awards, offset: 0, applied: true };
    } catch (err) {
        console.error('❌ readCheckboxes 失敗:', err);
        return { sets: [], offset: 0, applied: false, reason: 'exception:' + err.message };
    }
}

/**
 * 在版面座標附近找出長條的實際外框。
 *
 * 校正後的畫布跟版面模板之間仍有幾 px 到二十幾 px 的位移（定位點偵測誤差、
 * 紙張對折的弧形、拍照角度），而一筆橫線只有 2~3px 粗，位移一點就量不到。
 * 所以不直接相信模板座標，而是在附近逐點搜尋「四條邊都夠暗」的位置：
 * 取四條邊平均暗度的最小值當分數，只有真的長條外框四邊都暗；
 * 表格橫線、手寫字只會讓其中一兩條邊變暗，分數上不來。
 */
const SEARCH_X = 22, SEARCH_Y = 26; // 列高約 58px，Y 搜尋不能超過半列

function locateBar(img, box) {
    const w = box.x2 - box.x1, h = box.y2 - box.y1;
    let best = { score: -1, dx: 0, dy: 0 };
    for (let dy = -SEARCH_Y; dy <= SEARCH_Y; dy++) {
        for (let dx = -SEARCH_X; dx <= SEARCH_X; dx++) {
            const x1 = box.x1 + dx, y1 = box.y1 + dy;
            const sc = Math.min(
                edgeDark(img, x1, y1, w, 0),      // 上
                edgeDark(img, x1, y1 + h, w, 0),  // 下
                edgeDark(img, x1, y1, h, 1),      // 左
                edgeDark(img, x1 + w, y1, h, 1)   // 右
            );
            if (sc > best.score) best = { score: sc, dx, dy };
        }
    }
    return { x1: box.x1 + best.dx, y1: box.y1 + best.dy, x2: box.x2 + best.dx, y2: box.y2 + best.dy };
}

// 一條邊（含上下或左右各 1px，容許框線沒對正）的平均暗度，0~255
function edgeDark(img, x, y, len, vertical) {
    let sum = 0, n = 0;
    for (let k = 0; k <= len; k += 2) {
        let v = 0;
        for (let t = -1; t <= 1; t++) {
            const px = vertical ? x + t : x + k, py = vertical ? y + k : y + t;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            v = Math.max(v, 255 - img.data[py * img.width + px]);
        }
        sum += v; n++;
    }
    return n ? sum / n : 0;
}

/**
 * 一組左右兩個長條中，哪一條有筆跡。左＝主隊、右＝客隊是版面固定規則。
 *
 * 條通分紙只要求「勝方在長條內畫一筆」，一筆橫線大約只佔長條內部 8~20%，
 * 所以門檻比舊分紙（螺旋塗滿 40~60%）低很多；空白長條的雜訊約 0~3%。
 * 判斷看兩條的相對差距：有筆跡的那條要明顯比另一條多，否則交人工確認。
 */
const MIN_INK = 0.05;      // 至少要有這麼多墨跡才算有畫
const MAX_OTHER_RATIO = 0.45; // 另一條的墨跡不能超過這條的 45%

function decidePair(covLeft, covRight) {
    const hi = Math.max(covLeft, covRight), lo = Math.min(covLeft, covRight);
    if (hi < MIN_INK || lo > hi * MAX_OTHER_RATIO) {
        return { value: 'unclear', confidence: 0 };
    }
    const confidence = Math.round(Math.min(100, 50 + (hi - lo) * 400));
    return { value: covLeft > covRight ? 'home' : 'away', confidence };
}

function coverage(img, box, offset) {
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const x1 = Math.round(box.x1 + bw * INSET), x2 = Math.round(box.x2 - bw * INSET);
    const y1 = Math.round(box.y1 + offset + bh * INSET), y2 = Math.round(box.y2 + offset - bh * INSET);

    // 紙面亮度依照片打光差很多（同一張上下可差 100 以上），用框內最亮的部分
    // 當紙色、比紙色暗 DARK_DROP 以上才算墨跡，不用寫死的灰階值
    const vals = [];
    for (let y = y1; y < y2; y++) {
        if (y < 0 || y >= img.height) continue;
        for (let x = x1; x < x2; x++) {
            if (x < 0 || x >= img.width) continue;
            vals.push(img.data[y * img.width + x]);
        }
    }
    if (!vals.length) return 0;
    const sorted = vals.slice().sort((a, b) => a - b);
    const paper = sorted[Math.floor(sorted.length * 0.9)];
    const threshold = Math.min(DARK_LEVEL, paper - DARK_DROP);
    let dark = 0;
    for (const v of vals) if (v < threshold) dark++;
    return dark / vals.length;
}

/**
 * 三黑統計表：只判斷每一格「有沒有寫東西」，不讀數字（數字交給模型）。
 *
 * 實測模型讀數字本身沒問題，但常把數字放錯欄（HAT 的 2 回成白馬），跟舊分紙
 * 先攻／勝負被讀反是同一類空間錯誤。所以哪一格有寫由影像決定，模型只負責
 * 讀出寫的是幾。空白格實測是 0%，一個手寫數字約佔格子內部 2~6%（細的「1」只有 2%）。
 */
const CELL_INSET = 0.2;
const CELL_INK = 0.01;

function readAwardCells(img, dx, dy) {
    const L = AWARD_LAYOUT;
    const out = {};
    for (const side of ['home', 'away']) {
        out[side] = [];
        for (let r = 0; r < L.rows; r++) {
            const y1 = L.rowTop + r * L.rowHeight + dy, y2 = y1 + L.rowHeight;
            const cell = key => {
                const [x1, x2] = L[side][key];
                const box = { x1: x1 + dx, x2: x2 + dx, y1, y2 };
                const cov = coverageInset(img, box, CELL_INSET);
                return { ink: cov >= CELL_INK, coverage: +cov.toFixed(3) };
            };
            out[side].push({ row: r + 1, name: cell('name'), hat: cell('hat'), wh: cell('wh'), bed: cell('bed') });
        }
    }
    return out;
}

function coverageInset(img, box, inset) {
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    return coverage(img, {
        x1: box.x1 + bw * (inset - INSET), x2: box.x2 - bw * (inset - INSET),
        y1: box.y1 + bh * (inset - INSET), y2: box.y2 - bh * (inset - INSET),
    }, 0);
}

module.exports = { readCheckboxes, _internal: { locateBar, coverage, decidePair, readAwardCells } };
