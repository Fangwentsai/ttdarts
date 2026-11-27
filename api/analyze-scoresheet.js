/**
 * Vercel API Route: 分紙照片辨識
 *
 * 收到一張分紙照片 + 該場兩隊名單，辨識條通 15 局的選手、勝負，以及三黑統計表（HAT／白馬／床），
 * 每個欄位都附信心分數，交給前端依信心分級處理（見 SCORESHEET_OCR.md）。
 *
 * 設計要點（詳見 SCORESHEET_OCR.md 的實測發現）：
 *   - 不讀照片上的隊名/日期，兩隊由呼叫端傳入（來自使用者選擇的 gamecode）
 *   - 人名比對限定在該場兩隊的名單內，不開放自由辨識
 *   - 塗黑框可能是螺旋塗鴉而非塗滿，任何可見墨跡都算「已勾選」
 *   - 勝負長條用影像處理判讀（checkbox-reader.js），不交給模型
 *   - 15 局每局 1 分，讀出來的勝局數加總必須是 15，否則一定有局沒讀出來
 *   - 目前帳號的免費額度只開通 gemini-2.5-flash（已實測確認，
 *     2.5-pro / 2.0-flash 回傳 429 額度 0），故寫死使用該模型
 *   - 送給 Gemini 之前先用四角定位點把照片透視校正成正的矩形（deskew.js），
 *     讓模型不用自己在歪斜的照片裡判斷左右空間關係——這是 SCORESHEET_OCR.md
 *     發現①（先攻/勝負讀反）的源頭修正，不是事後修補
 */

const { deskewScoresheet } = require('./_lib/deskew');
const { readCheckboxes } = require('./_lib/checkbox-reader');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_HOST = 'https://generativelanguage.googleapis.com';

// 條通 15 局的人數，對應 pages/scoresheet.html 的 SETS 定義
const SET_DEFS = [
    { set: 1, players: 1, game: 'Count Up' },
    { set: 2, players: 1, game: '501 DI/DO' },
    { set: 3, players: 2, game: 'Half It' },
    { set: 4, players: 1, game: '501 OI/OO 女子賽' },
    { set: 5, players: 1, game: 'Cricket' },
    { set: 6, players: 2, game: 'VS ARCHERY' },
    { set: 7, players: 4, game: '901 OI/OO' },
    { set: 8, players: 1, game: '701 OI/MO' },
    { set: 9, players: 2, game: 'Cricket' },
    { set: 10, players: 2, game: 'HIDDEN CR' },
    { set: 11, players: 1, game: 'HYPER JUMP' },
    { set: 12, players: 1, game: '501 硬式 OI/DO' },
    { set: 13, players: 2, game: '701 TEAM FREEZE' },
    { set: 14, players: 2, game: '701 OI/OO' },
    { set: 15, players: 4, game: 'Cricket' },
];
const TOTAL_SETS = SET_DEFS.length; // 15，每局 1 分

// 條通規則：一般選手每場最多出賽 8 局（A 級選手 5 局，名單上沒有等級資料，先只檢查 8 局）
const MAX_SETS_PER_PLAYER = 8;
// 三黑統計表每隊幾列（跟分紙一致）
const AWARD_ROWS = 8;

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '伺服器未設定 GEMINI_API_KEY' });
    }

    try {
        const { image, mimeType, gameCode, homeTeam, awayTeam, homeRoster, awayRoster } = req.body || {};

        const missing = [];
        if (!image) missing.push('image');
        if (!homeTeam) missing.push('homeTeam');
        if (!awayTeam) missing.push('awayTeam');
        if (!Array.isArray(homeRoster) || homeRoster.length === 0) missing.push('homeRoster');
        if (!Array.isArray(awayRoster) || awayRoster.length === 0) missing.push('awayRoster');
        if (missing.length) {
            return res.status(400).json({ error: `缺少必要欄位：${missing.join(', ')}` });
        }

        const { data: imageData, mimeType: resolvedMimeType } = parseImage(image, mimeType);

        // 校正失敗（例如定位點被手指擋住、照片裁太緊）就照原圖送出，
        // 不要因為校正這一步失敗就整個辨識請求失敗
        const deskew = await deskewScoresheet(Buffer.from(imageData, 'base64'));
        const finalImageData = deskew.applied ? deskew.buffer.toString('base64') : imageData;
        const finalMimeType = deskew.applied ? 'image/jpeg' : resolvedMimeType;

        const geminiResult = await callGemini({
            apiKey,
            imageData: finalImageData,
            mimeType: finalMimeType,
            gameCode,
            homeTeam,
            awayTeam,
            homeRoster,
            awayRoster,
        });

        const withSides = mapSidesToTeams(geminiResult);

        // 塗黑框改用影像處理判讀，蓋掉模型給的先攻／勝負（見 overrideWithPixelReading）。
        // 需要校正成功才有固定座標可量，校正失敗就只能沿用模型的答案。
        const pixelRead = deskew.applied ? await readCheckboxes(deskew.buffer) : { applied: false, reason: 'deskew-skipped' };
        const withPixelBoxes = mergeAwardCells(overrideWithPixelReading(withSides, pixelRead), pixelRead);

        const withRosterMatch = applyRosterMatching(withPixelBoxes, homeRoster, awayRoster);
        const withCrossCheck = applyCrossCheck(withRosterMatch);
        withCrossCheck.deskew = { applied: deskew.applied, reason: deskew.reason || null };
        withCrossCheck.checkboxSource = pixelRead.applied ? 'pixel' : 'gemini';

        return res.status(200).json(withCrossCheck);
    } catch (err) {
        console.error('❌ analyze-scoresheet 失敗:', err);
        // 不要把內部錯誤細節（可能含請求內容）原樣丟給前端
        const message = err.userMessage || 'Gemini 辨識失敗，請稍後再試或直接手動填寫';
        // Google 建議的重試等待秒數（沒有就不附這個欄位，前端自己套固定備援值）
        const body = { error: message };
        if (err.retryDelayMs) body.retryDelayMs = err.retryDelayMs;
        return res.status(err.statusCode || 500).json(body);
    }
};

/**
 * 接受 data URL（"data:image/jpeg;base64,xxx"）或純 base64 字串。
 */
function parseImage(image, fallbackMimeType) {
    const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
    if (match) {
        return { mimeType: match[1], data: match[2] };
    }
    return { mimeType: fallbackMimeType || 'image/jpeg', data: image };
}

// 免費額度的 RPM（每分鐘請求數）上限很低，六場比賽的分紙照片如果集中在
// 賽後同一段時間上傳，很容易同時撞上這個上限、回傳 429。
//
// 一開始這裡寫的是「429 就等 1.2s / 2.5s 後重試」，但這個間隔幾乎沒用：
// RPM 是以「分鐘」為單位的視窗，幾秒鐘的重試大機率還在同一個已經打滿的
// 視窗裡，等於是在同一分鐘內又追加了好幾次注定失敗的請求，反而讓額度
// 更快見底。改成讀 Google 錯誤回應裡附的 google.rpc.RetryInfo.retryDelay
// （明確告訴你要等多久，通常是幾十秒），只有這個值短到還塞得進 Vercel
// 的執行時間上限（Hobby 方案 10 秒）才在伺服器端等一次；如果建議的等待
// 時間比較長，就不在這裡硬等，直接把 retryDelay 一併回給前端，讓前端
// （沒有執行時間限制）自己去等精確的秒數再重試，而不是用猜的固定值。
const GEMINI_SERVER_RETRY_BUDGET_MS = 3000; // 伺服器端最多願意多等這麼久

function parseRetryDelayMs(json) {
    const detail = json?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    const raw = detail?.retryDelay; // 例如 "30s" 或 "12.500s"
    if (!raw) return null;
    const match = /^([\d.]+)s$/.exec(raw);
    return match ? Math.round(parseFloat(match[1]) * 1000) : null;
}

async function fetchGeminiWithRetry(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await response.json();

    if (response.status !== 429) {
        return { response, json };
    }

    const retryDelayMs = parseRetryDelayMs(json);

    // Google 沒給建議等待時間，或建議的時間太長塞不進執行時間上限，
    // 就不在這裡硬等——直接把 retryDelayMs 帶回去給前端自己決定怎麼等。
    if (retryDelayMs === null || retryDelayMs > GEMINI_SERVER_RETRY_BUDGET_MS) {
        return { response, json, retryDelayMs };
    }

    console.warn(`⚠️ Gemini 429，依 retryDelay 等待 ${retryDelayMs}ms 後重試一次`);
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));

    const retryResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const retryJson = await retryResponse.json();
    return {
        response: retryResponse,
        json: retryJson,
        retryDelayMs: retryResponse.status === 429 ? parseRetryDelayMs(retryJson) : null,
    };
}

async function callGemini({ apiKey, imageData, mimeType, gameCode, homeTeam, awayTeam, homeRoster, awayRoster }) {
    const prompt = buildPrompt({ gameCode, homeTeam, awayTeam, homeRoster, awayRoster });
    const schema = buildResponseSchema();

    const url = `${GEMINI_API_HOST}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body = {
        contents: [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType, data: imageData } },
            ],
        }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.1, // 辨識任務要穩定輸出，不要有創意
        },
    };

    const { response, json, retryDelayMs } = await fetchGeminiWithRetry(url, body);

    if (!response.ok) {
        const err = new Error(json?.error?.message || `Gemini API 錯誤 (HTTP ${response.status})`);
        err.statusCode = response.status === 429 ? 429 : 502;
        err.userMessage = response.status === 429
            ? 'Gemini API 額度已用完，請稍後再試'
            : 'Gemini 辨識服務暫時無法使用';
        // 附上 Google 建議的等待秒數，前端沒有拿到就用固定值當備援
        if (response.status === 429 && retryDelayMs) {
            err.retryDelayMs = retryDelayMs;
        }
        throw err;
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        const err = new Error('Gemini 回應中沒有可用內容');
        err.userMessage = '辨識結果為空，請確認照片清晰且四角定位點完整入鏡';
        throw err;
    }

    try {
        return JSON.parse(text);
    } catch (parseErr) {
        console.error('無法解析 Gemini 回應為 JSON:', text);
        const err = new Error('Gemini 回應格式錯誤');
        err.userMessage = '辨識結果格式異常，請直接手動填寫';
        throw err;
    }
}

function buildPrompt({ gameCode, homeTeam, awayTeam, homeRoster, awayRoster }) {
    const label = n => (n === 1 ? '單人' : n === 2 ? '雙人' : '四人');
    const setList = SET_DEFS.map(d => `SET${d.set}：${label(d.players)}（${d.game}）`).join('\n');

    return `你是一個飛鏢比賽分紙的辨識助手。這張分紙的版面結構固定如下：

- 頁首：場次、日期、主隊「${homeTeam}」、客隊「${awayTeam}」
- 主表格 15 列（SET1~SET15），每列從左到右依序是 5 個區塊：
  1. 最左：主隊的「勝」長條框
  2. 主隊選手（手寫姓名，單人局 1 格、雙人局 2 格並排、四人局 2x2 四格）
  3. 正中：SET 編號與局別說明
  4. 客隊選手（同上）
  5. 最右：客隊的「勝」長條框
- 主表格下方是「三黑統計表」，左邊一張是主隊、右邊一張是客隊，各 ${AWARD_ROWS} 列。
  每列從左到右是：選手姓名、HAT 次數、白馬次數、床次數（手寫阿拉伯數字，沒有就留白）

各局人數：
${setList}

重要規則：
1. **主隊選手只能是以下名單中的人，不要辨識成名單外的名字**：
   ${homeRoster.join('、')}
2. **客隊選手只能是以下名單中的人**：
   ${awayRoster.join('、')}
3. 每一局回傳的選手數要等於該局人數；四人局的四個名字分在上下兩排，請全部讀出，不要漏讀下排。讀不出來的格子回傳 name: null，不要省略。
4. **單字與簡稱綽號比對**：手寫可能只寫單字或簡稱，請優先比對並回傳名單中的完整標準姓名。
5. **winner 只回答長條框「在左邊還右邊」有筆跡（left/right），不要自己換算成主隊或客隊**。勝方通常只在長條裡畫一筆，不一定塗滿；兩邊都沒有或都有筆跡就回 unclear。
6. **三黑統計表**：
   - 主隊那張的姓名只能是主隊名單中的人，客隊那張只能是客隊名單中的人
   - 整列空白（沒有寫名字）就不要回傳那一列；有回傳的列要附上 row（由上往下第幾列，1~8）
   - 次數讀成整數；格子空白回傳 0，看不清楚回傳 null 並給低信心
   - 這三個數字通常是 0~5 的小數字，讀到很大的數字請再確認一次
7. 若某個欄位字跡潦草、模糊到你沒有把握，請誠實給出低信心分數（甚至 0），**不要用猜測填一個看起來合理但沒有根據的答案**。
8. 場次代號如果照片上有寫，讀出來放進 gameCodeOnPhoto；這場的實際場次是「${gameCode || '未提供'}」，僅供交叉核對。
9. **塗改（劃掉重寫）的姓名**：被劃掉的名字一律不是答案，要讀補寫的那一個；只要這一格有劃掉的痕跡，就把 strikethrough 設為 true；分不出哪個才是最終答案時 name 回傳 null。

信心分數（0~100）是針對「這個具體欄位」的判讀依據給分：
- 90~100：筆跡清楚、無歧義，換一個人來看也只會有一種讀法
- 60~89：看得出來，但有一點模糊、或可能跟名單裡另一個名字接近
- 30~59：潦草、被遮擋一部分，你其實是用猜的
- 0~29：幾乎看不出來、被遮擋、或完全空白
**同一張照片裡不應該所有欄位都給 90 以上**——如果你發現自己對每一格都很有把握，先停下來重新檢查。`;
}

function buildResponseSchema() {
    const playerField = {
        type: 'OBJECT',
        properties: {
            name: { type: 'STRING', nullable: true },
            confidence: { type: 'INTEGER' },
            // 這一格有沒有被劃掉重寫的痕跡。實測發現塗改格是姓名誤判的主要來源：
            // 模型可能讀到被劃掉的舊名字卻給出高信心（見 SCORESHEET_OCR.md 發現 13）
            strikethrough: { type: 'BOOLEAN' },
        },
        required: ['name', 'confidence', 'strikethrough'],
    };

    const choiceField = (enumValues) => ({
        type: 'OBJECT',
        properties: {
            value: { type: 'STRING', enum: enumValues },
            confidence: { type: 'INTEGER' },
        },
        required: ['value', 'confidence'],
    });

    const countField = {
        type: 'OBJECT',
        properties: {
            value: { type: 'INTEGER', nullable: true },
            confidence: { type: 'INTEGER' },
        },
        required: ['value', 'confidence'],
    };

    const awardRow = {
        type: 'OBJECT',
        properties: {
            // 第幾列（1~8，由上往下）。影像判讀要靠這個對到實際的格子
            row: { type: 'INTEGER' },
            player: playerField,
            hat: countField,
            wh: countField,
            bed: countField,
        },
        required: ['row', 'player', 'hat', 'wh', 'bed'],
    };

    return {
        type: 'OBJECT',
        properties: {
            gameCodeOnPhoto: { type: 'STRING', nullable: true },
            sets: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    properties: {
                        set: { type: 'INTEGER' },
                        homePlayers: { type: 'ARRAY', items: playerField },
                        awayPlayers: { type: 'ARRAY', items: playerField },
                        // 故意要求「左邊還右邊」而不是「主隊還客隊」：實測直接要求 home/away
                        // 時模型會穩定讀反。左＝主、右＝客由程式決定（見 mapSidesToTeams）。
                        // 校正成功時這個欄位會被影像判讀的結果蓋掉，只在校正失敗時當備援。
                        winner: choiceField(['left', 'right', 'unclear']),
                    },
                    required: ['set', 'homePlayers', 'awayPlayers', 'winner'],
                },
            },
            awards: {
                type: 'OBJECT',
                properties: {
                    home: { type: 'ARRAY', items: awardRow },
                    away: { type: 'ARRAY', items: awardRow },
                },
                required: ['home', 'away'],
            },
        },
        required: ['sets', 'awards'],
    };
}

// ===== 後處理 0：左右側轉換成主客隊 =====
// Gemini 只負責回答視覺上的「左邊還右邊」（見 buildPrompt 規則 8 的說明），
// 「左側=主隊、右側=客隊」這個固定版面規則由這裡的程式碼決定，不假手模型
// 做語意翻譯——這是實測發現直接要求模型輸出 home/away 時會穩定讀反
// （100% 精確反過來）之後的修正，SCORESHEET_OCR.md 發現 10/11 有記錄。

const SIDE_TO_TEAM = { left: 'home', right: 'away', unclear: 'unclear' };

function mapSidesToTeams(result) {
    const sets = (result.sets || []).map(s => ({
        ...s,
        winner: mapSideField(s.winner),
    }));
    return { ...result, sets };
}

function mapSideField(field) {
    if (!field) return field;
    const mapped = SIDE_TO_TEAM[field.value];
    return { ...field, value: mapped === undefined ? field.value : mapped };
}

// ===== 後處理 0.5：塗黑框改用影像判讀的結果 =====
// 先攻／勝負是純視覺量測（哪一格有墨跡），不需要語意理解，交給模型反而不穩：
// 同一張照片多次重跑，正確率在 25%~75% 之間跳，最差一次 16 局全部回同一個值，
// 而且信心分數不論對錯都固定在 90~95。改量墨水覆蓋率後同一張照片得到
// 先攻 93.8%、勝負 87.5%，且三個錯誤全部落在 unclear／信心 0，
// 沒有任何「高信心答錯」。詳見 SCORESHEET_OCR.md 發現 14。

function overrideWithPixelReading(result, pixelRead) {
    if (!pixelRead.applied) return result;

    const bySet = new Map(pixelRead.sets.map(s => [s.set, s]));
    const sets = (result.sets || []).map(s => {
        const px = bySet.get(s.set);
        if (!px) return s;
        return { ...s, winner: px.winner };
    });
    return { ...result, sets };
}

// ===== 後處理 0.6：三黑表的數字放到對的欄 =====
// 實測模型讀數字沒問題，但會放錯欄（HAT 的 2 回成白馬）。哪一格有寫字由影像
// 判讀決定（readAwardCells），模型只負責讀「寫的是幾」：
//   - 影像說空白 → 一定是 0
//   - 影像說有寫、模型在同一格也有讀到數字 → 用模型的數字
//   - 數字落點跟影像不一致時，若這一列「有寫的格數」等於「模型讀到的非零數字個數」，
//     就依左到右的順序重新對應（模型通常只是整排錯位）；對不起來就標成讀不出來

const AWARD_KEYS = ['hat', 'wh', 'bed'];

function mergeAwardCells(result, pixelRead) {
    if (!pixelRead.applied || !pixelRead.awards) return result;
    const awards = {};
    for (const side of ['home', 'away']) {
        awards[side] = (result.awards?.[side] || []).map(r => {
            const px = pixelRead.awards[side][(r.row || 0) - 1];
            if (!px) return { ...r, pixel: false };
            const inked = AWARD_KEYS.filter(k => px[k].ink);
            const values = AWARD_KEYS.map(k => r[k]).filter(f => f && f.value);
            const fixed = { ...r, pixel: true };
            const placedRight = AWARD_KEYS.every(k => px[k].ink === !!(r[k] && r[k].value));
            if (placedRight) {
                AWARD_KEYS.forEach(k => { if (!px[k].ink) fixed[k] = { value: 0, confidence: 100 }; });
            } else if (inked.length === values.length) {
                AWARD_KEYS.forEach(k => { fixed[k] = { value: 0, confidence: 100 }; });
                inked.forEach((k, i) => { fixed[k] = { value: values[i].value, confidence: Math.min(values[i].confidence, 70), realigned: true }; });
            } else {
                AWARD_KEYS.forEach(k => {
                    fixed[k] = px[k].ink
                        ? (r[k] && r[k].value ? { ...r[k], confidence: Math.min(r[k].confidence, 40) } : { value: null, confidence: 0 })
                        : { value: 0, confidence: 100 };
                });
            }
            return fixed;
        });
    }
    return { ...result, awards };
}

// ===== 後處理 1：名單模糊比對 =====
// 模型有時仍會回傳名單外的名字（尤其是低信心的情況），這裡再比對一次，
// 不完全信任模型自己「保證只選名單內」的承諾。

// 塗改格的信心懲罰。分紙上把寫錯的名字劃掉、旁邊補寫，是姓名誤判的主要來源：
// 實測有格子讀到「被劃掉的舊名字」卻給了 90 分信心（見 SCORESHEET_OCR.md 發現 13）。
// 這種格子不論模型自己多有把握，都不該自動填入——扣 50 分讓它必定跌出
// 「高信心自動填入」的範圍，強制走人工確認。
//
// 正規做法是請記錄員用修正液把寫錯的字清乾淨再重寫（劃掉重寫本來就不是
// 給機器判讀的寫法，就像考卷劃記不能打叉重選），這點會另外向各隊說明。
const STRIKETHROUGH_PENALTY = 50;

function applyRosterMatching(result, homeRoster, awayRoster) {
    const sets = (result.sets || []).map(s => ({
        ...s,
        homePlayers: (s.homePlayers || []).map(p => matchAgainstRoster(p, homeRoster)),
        awayPlayers: (s.awayPlayers || []).map(p => matchAgainstRoster(p, awayRoster)),
    }));
    const awardSide = (rows, roster) => (rows || [])
        .filter(r => r && r.player && r.player.name)
        .slice(0, AWARD_ROWS)
        .map(r => ({ ...r, player: matchAgainstRoster(r.player, roster) }));
    const awards = {
        home: awardSide(result.awards?.home, homeRoster),
        away: awardSide(result.awards?.away, awayRoster),
    };
    return { ...result, sets, awards };
}

function matchAgainstRoster(player, roster) {
    if (!player || !player.name) {
        return { name: null, confidence: 0, strikethrough: !!(player && player.strikethrough) };
    }

    const matched = matchName(player, roster);
    if (!player.strikethrough) return matched;

    return {
        ...matched,
        confidence: Math.max(0, matched.confidence - STRIKETHROUGH_PENALTY),
        strikethrough: true,
    };
}

function matchName(player, roster) {
    if (!player || !player.name) return player;
    let name = player.name.trim();

    // 1. 特殊符號 +0 / +o 等價對映
    if (/^[\+＋][0oO]$/i.test(name)) {
        const symbolMatch = roster.find(r => /^[\+＋][0oO]$/i.test(r));
        if (symbolMatch) return { ...player, name: symbolMatch };
    }

    // 2. 常用英文縮寫、數字代號與拼音別名對照 (Common Aliases & Phonetic Transliteration)
    const COMMON_ALIASES = {
        '91': ['Joy', 'joy'],
        'lu': ['Louis', 'louis', '小安'],
        'yu': ['邱昱', 'yu'],
        'fei': ['小飛'],
        'chi': ['小齊'],
        'yiheng': ['羿珩'],
        'ben': ['Ben', 'ben'],
        'andy': ['Andi', 'andi', 'Andy'],
        'kaman': ['Kaman', 'kaman'],
        'jj': ['JJ', 'jj'],
    };

    const lowerName = name.toLowerCase();
    if (COMMON_ALIASES[lowerName]) {
        const candidates = COMMON_ALIASES[lowerName];
        const found = roster.find(r => candidates.some(c => c.toLowerCase() === r.toLowerCase()));
        if (found) {
            return { ...player, name: found, confidence: Math.max(0, Math.min(player.confidence || 90, 100)) };
        }
    }

    if (roster.includes(name)) {
        return player; // 完全對上，信心分數維持模型給的值
    }

    // 3. 大小寫相符對比
    const caseInsensitive = roster.find(r => r.toLowerCase() === name.toLowerCase());
    if (caseInsensitive) {
        return { ...player, name: caseInsensitive };
    }

    // 3. 單字簡稱對照（手寫僅填單字如「喵」對應「喵喵」）
    if (name.length === 1) {
        const matches = roster.filter(r => r.includes(name));
        if (matches.length === 1) {
            return { ...player, name: matches[0], confidence: Math.max(0, Math.min(player.confidence, 100) - 5) };
        }
    }

    // 4. 編輯距離比對
    const ranked = rankByDistance(name, roster);
    const best = ranked[0], runnerUp = ranked[1];
    if (best && best.distance <= 1) {
        const ambiguous = runnerUp && runnerUp.distance === best.distance;
        const penalty = ambiguous ? 30 : 5;
        return { ...player, name: best.name, confidence: Math.max(0, Math.min(player.confidence, 100) - penalty) };
    }
    // 名單裡完全找不到接近的人，強制降到需要人工確認
    return { ...player, name: name, confidence: Math.min(player.confidence, 30), notInRoster: true };
}

// 回傳整份名單依相近程度排序的結果，而不是只有最接近的那一個——
// 判斷可不可信要看「最近的跟第二近的差多少」，只拿到冠軍看不出有沒有並列。
// 比對時忽略大小寫，否則 Lucy/lucy 這種差異會佔掉唯一的一格距離額度。
function rankByDistance(name, roster) {
    return roster
        .map(candidate => ({ name: candidate, distance: levenshtein(name.toLowerCase(), candidate.toLowerCase()) }))
        .sort((a, b) => a.distance - b.distance);
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// ===== 後處理 2：客觀驗算 =====
// 15 局每局 1 分，兩隊勝局數加總必須是 15；不到 15 代表有局的勝負沒讀出來。
// 另外檢查：每人出賽局數上限、三黑表上的人有沒有出賽。

function applyCrossCheck(result) {
    const sets = result.sets || [];
    let homeWins = 0, awayWins = 0;
    const unclearSets = [];

    sets.forEach(s => {
        if (s.winner?.value === 'home') homeWins++;
        else if (s.winner?.value === 'away') awayWins++;
        else unclearSets.push(s.set);
    });

    const appearances = { home: new Map(), away: new Map() };
    sets.forEach(s => {
        for (const [side, list] of [['home', s.homePlayers], ['away', s.awayPlayers]]) {
            for (const p of list || []) {
                if (!p || !p.name) continue;
                appearances[side].set(p.name, (appearances[side].get(p.name) || 0) + 1);
            }
        }
    });
    const overLimit = [];
    for (const side of ['home', 'away']) {
        for (const [name, count] of appearances[side]) {
            if (count > MAX_SETS_PER_PLAYER) overLimit.push({ team: side, name, count, limit: MAX_SETS_PER_PLAYER });
        }
    }

    // 三黑表上的選手如果整場都沒出賽，多半是姓名認錯
    const awardsWithoutPlay = [];
    for (const side of ['home', 'away']) {
        for (const r of result.awards?.[side] || []) {
            if (r.player?.name && !appearances[side].has(r.player.name)) awardsWithoutPlay.push({ team: side, name: r.player.name });
        }
    }

    return {
        ...result,
        crossCheck: {
            computedHomeWins: homeWins,
            computedAwayWins: awayWins,
            expectedSum: TOTAL_SETS,
            sumValid: homeWins + awayWins === TOTAL_SETS,
            unclearSets,       // 這些局的勝負沒有讀出來，人工確認時要特別注意
            overLimit,         // 出賽超過上限的選手
            awardsWithoutPlay, // 三黑表上有名字、但 15 局都沒出賽
        },
    };
}
