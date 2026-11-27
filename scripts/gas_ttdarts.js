/**
 * TTDarts（條通聯盟）後台寫入用 Google Apps Script
 *
 * 部署方式：在 TT 試算表裡「擴充功能 → Apps Script」，把整份貼上，
 * 「部署 → 新增部署作業 → 網頁應用程式」，執行身分選「我」、存取權選「所有人」。
 * 拿到的 /exec 網址填到網站 js/admin-sheets-api.js 的 SCRIPT_URL。
 *
 * 只處理條通的 15 局制，不沿用難找的聯賽的 GAS（那支寫死舊聯盟的試算表）。
 *
 * POST body（JSON 字串，Content-Type 用 text/plain 避免 CORS 預檢）：
 * {
 *   "gameId": "G01",
 *   "gameDate": "2026/12/1",
 *   "homeTeam": "主隊", "awayTeam": "客隊",
 *   "sets": [ { "set": 1, "home": ["小明"], "away": ["小華"], "winner": "home" }, ... 共 15 局 ],
 *   "awards": {
 *     "home": [ { "name": "小明", "hat": 1, "wh": 0, "bed": 2 } ],
 *     "away": [ ... ]
 *   }
 * }
 *
 * 寫入：
 *   results  每局一列（同一場重送會先刪掉舊的再寫，不會重複）
 *   awards   每位選手一列（同上）
 *   data     每位選手一列出賽／勝場，personal 分頁的公式會自動加總
 *   schedule 該場的比分（勝局數）、勝隊、敗隊，排名公式自動重算
 */

// 試算表 ID：Apps Script 綁在這份試算表上時可以不填，會自動用目前的試算表
var SHEET_ID = '1gXWx_QRm_MZkLvrnecBi0x5QpL2XmsoXZXPGYbUD_nc';

// 條通 15 局的項目，跟分紙、規則頁一致
var SETS = {
  1: { type: '單人 Count Up', kind: 'other' },
  2: { type: '單人 501 DI/DO', kind: '01' },
  3: { type: '雙人 Half It', kind: 'other' },
  4: { type: '單人 501 OI/OO 女子賽', kind: '01' },
  5: { type: '單人 Cricket', kind: 'cr' },
  6: { type: '雙人 VS ARCHERY', kind: 'other' },
  7: { type: '四人 901 OI/OO', kind: '01' },
  8: { type: '單人 701 OI/MO', kind: '01' },
  9: { type: '雙人 Cricket', kind: 'cr' },
  10: { type: '雙人 HIDDEN CR', kind: 'cr' },
  11: { type: '單人 HYPER JUMP', kind: 'other' },
  12: { type: '單人 501 硬式 OI/DO', kind: '01' },
  13: { type: '雙人 701 TEAM FREEZE', kind: '01' },
  14: { type: '雙人 701 OI/OO', kind: '01' },
  15: { type: '四人 Cricket', kind: 'cr' }
};
var TOTAL_SETS = 15;

function doGet() {
  return json({ status: 'ok', message: 'TTDarts GAS ready' });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return json(saveGame(data));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ status: 'error', message: String(err && err.message || err) });
  }
}

function saveGame(d) {
  validate(d);
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

  // ---- results：每局一列 ----
  var results = ss.getSheetByName('results');
  deleteRowsOfGame(results, 2, d.gameId);
  var resultRows = d.sets.map(function (s) {
    return [d.gameDate, d.gameId, s.set, SETS[s.set].type,
      d.homeTeam, s.home.join('、'), d.awayTeam, s.away.join('、'),
      s.winner === 'home' ? d.homeTeam : d.awayTeam, now];
  });
  appendRows(results, resultRows);

  // ---- awards：每位選手一列，只寫有次數的 ----
  var awards = ss.getSheetByName('awards');
  deleteRowsOfGame(awards, 2, d.gameId);
  var awardRows = [];
  ['home', 'away'].forEach(function (side) {
    var team = side === 'home' ? d.homeTeam : d.awayTeam;
    ((d.awards || {})[side] || []).forEach(function (a) {
      var hat = toInt(a.hat), wh = toInt(a.wh), bed = toInt(a.bed);
      if (a.name && (hat || wh || bed)) awardRows.push([d.gameDate, d.gameId, team, a.name, hat, wh, bed, now]);
    });
  });
  appendRows(awards, awardRows);

  // ---- data：每位選手的出賽／勝場 ----
  var stats = {};
  d.sets.forEach(function (s) {
    var kind = SETS[s.set].kind;
    ['home', 'away'].forEach(function (side) {
      var team = side === 'home' ? d.homeTeam : d.awayTeam;
      var won = s.winner === side;
      s[side].forEach(function (name) {
        var k = team + '\u0000' + name;
        var p = stats[k] || (stats[k] = { team: team, name: name, p01: 0, w01: 0, pcr: 0, wcr: 0, pall: 0, wall: 0 });
        p.pall++; if (won) p.wall++;
        if (kind === '01') { p.p01++; if (won) p.w01++; }
        if (kind === 'cr') { p.pcr++; if (won) p.wcr++; }
      });
    });
  });
  var dataSheet = ss.getSheetByName('data');
  deleteRowsOfGame(dataSheet, 10, d.gameId);
  appendRows(dataSheet, Object.keys(stats).map(function (k) {
    var p = stats[k];
    // 選手, 01出賽, 01勝場, CR出賽, CR勝場, 合計出賽, 合計勝場, 先攻數, 日期, 遊戲編號, 隊伍
    return [p.name, p.p01, p.w01, p.pcr, p.wcr, p.pall, p.wall, 0, d.gameDate, d.gameId, p.team];
  }));

  // ---- schedule：比分 = 勝局數 ----
  var homeWins = d.sets.filter(function (s) { return s.winner === 'home'; }).length;
  var awayWins = TOTAL_SETS - homeWins;
  var sched = ss.getSheetByName('schedule');
  var ids = sched.getRange(2, 1, Math.max(sched.getLastRow() - 1, 1), 1).getValues();
  var row = -1;
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === d.gameId) { row = i + 2; break; }
  var scheduleUpdated = false;
  if (row > 0) {
    var winner = homeWins > awayWins ? d.homeTeam : d.awayTeam;
    var loser = homeWins > awayWins ? d.awayTeam : d.homeTeam;
    sched.getRange(row, 4).setValue(awayWins);          // D 客場分數
    sched.getRange(row, 6).setValue(homeWins);          // F 主場分數
    sched.getRange(row, 9, 1, 2).setValues([[winner, loser]]); // I 勝、J 敗
    sched.getRange(row, 12, 1, 2).setValues([['', '']]);       // L/M 和局（15 局不會和）
    scheduleUpdated = true;
  }

  return {
    status: 'success',
    gameId: d.gameId,
    timestamp: new Date().toISOString(),
    score: { home: homeWins, away: awayWins },
    rows: { results: resultRows.length, awards: awardRows.length, data: Object.keys(stats).length },
    scheduleUpdated: scheduleUpdated,
    warning: scheduleUpdated ? '' : 'schedule 找不到 ' + d.gameId + '，比分沒有寫入賽程表'
  };
}

function validate(d) {
  if (!d || !/^G\d+$/.test(String(d.gameId || ''))) throw new Error('gameId 格式錯誤，例如 G01');
  if (!d.homeTeam || !d.awayTeam) throw new Error('缺少主隊或客隊');
  if (!Array.isArray(d.sets) || d.sets.length !== TOTAL_SETS) throw new Error('sets 必須剛好 15 局');
  var seen = {};
  d.sets.forEach(function (s) {
    if (!SETS[s.set]) throw new Error('SET 編號錯誤：' + s.set);
    if (seen[s.set]) throw new Error('SET' + s.set + ' 重複');
    seen[s.set] = true;
    if (s.winner !== 'home' && s.winner !== 'away') throw new Error('SET' + s.set + ' 沒有勝方');
    s.home = (s.home || []).filter(Boolean);
    s.away = (s.away || []).filter(Boolean);
  });
}

// 刪掉某一欄等於 gameId 的所有列（從下往上刪，列號才不會跑掉）
function deleteRowsOfGame(sheet, col, gameId) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]).trim() === gameId) sheet.deleteRow(i + 2);
  }
}

function appendRows(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function toInt(v) {
  var n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
