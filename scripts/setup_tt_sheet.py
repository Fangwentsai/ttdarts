#!/usr/bin/env python3
"""把使用者新開的 TT 試算表設定成「賽季 + 後台結果」共用的那一份。

1. 從 TTDarts 第一屆（已清空舊聯盟資料的範本）複製 data / schedule / streaming /
   ocr_log / personal 五個分頁過來（先複製被參照的分頁，公式才不會 #REF!）
2. 新增 results（逐局結果）與 awards（三黑統計）兩個分頁
3. schedule 的 O:V 排名公式改成條通算法：每局 1 分、勝隊 +2，沒有飲酒加成
4. 刪掉預設的空白「工作表1」

用法：python3 setup_tt_sheet.py [--dry-run]
"""
import sys
import sheets_api as s

SRC = '1Mbz2Xn_Vo_m30uW7EGBJt4jIseRN93Qpfyztqo9XDcw'   # TTDarts 第一屆（範本，已清空）
DST = '1gXWx_QRm_MZkLvrnecBi0x5QpL2XmsoXZXPGYbUD_nc'   # 使用者新開的 TT 試算表
TABS = ['data', 'schedule', 'streaming', 'ocr_log', 'personal']
TEAM_ROWS = 12  # 排名區預留 12 隊

dst_tabs = {sh['properties']['title']: sh['properties']['sheetId'] for sh in s.meta(DST)['sheets']}
print('目標試算表目前分頁:', list(dst_tabs))
if set(TABS) & set(dst_tabs):
    sys.exit('目標已經有同名分頁，停止以免覆蓋')
for t in dst_tabs:
    if s.read(f'{t}!A1:Z50', sheet_id=DST):
        sys.exit(f'目標分頁 {t} 不是空的，停止以免覆蓋')
if '--dry-run' in sys.argv:
    sys.exit('dry-run，未改動')

src_tabs = {sh['properties']['title']: sh['properties']['sheetId'] for sh in s.meta(SRC)['sheets']}
for t in TABS:
    r = s._req(f'{s.BASE}{SRC}/sheets/{src_tabs[t]}:copyTo', 'POST', {'destinationSpreadsheetId': DST})
    s.batch_update([{'updateSheetProperties': {'properties': {'sheetId': r['sheetId'], 'title': t}, 'fields': 'title'}}], sheet_id=DST)
    print('已複製', t)

s.batch_update([
    {'addSheet': {'properties': {'title': 'results', 'gridProperties': {'frozenRowCount': 1}}}},
    {'addSheet': {'properties': {'title': 'awards', 'gridProperties': {'frozenRowCount': 1}}}},
] + [{'deleteSheet': {'sheetId': sid}} for sid in dst_tabs.values()], sheet_id=DST)

s.write('results!A1:J1', [['日期', '遊戲編號', 'SET', '項目', '主隊', '主隊選手', '客隊', '客隊選手', '勝方', '寫入時間']], sheet_id=DST)
s.write('awards!A1:H1', [['日期', '遊戲編號', '隊伍', '選手', 'HAT', '白馬', '床', '寫入時間']], sheet_id=DST)

# schedule 排名區：P 隊名由使用者填；Q 勝、R 敗、S 和、T 勝局數、U 勝隊加分、V 總積分
n = TEAM_ROWS + 1
rows = []
for r in range(2, n + 1):
    rows.append([
        f'=IF(P{r}="","",RANK(V{r},$V$2:$V${n}))',
        '',
        f'=IF(P{r}="","",COUNTIF(I:I,P{r}))',
        f'=IF(P{r}="","",COUNTIF(J:J,P{r}))',
        f'=IF(P{r}="","",COUNTIF(L:L,P{r})+COUNTIF(M:M,P{r}))',
        f'=IF(P{r}="","",SUMIF(C:C,P{r},D:D)+SUMIF(G:G,P{r},F:F))',
        f'=IF(P{r}="","",Q{r}*2)',
        f'=IF(P{r}="","",T{r}+U{r})',
    ])
s.write(f'schedule!O2:V{n}', rows, sheet_id=DST)
s.write('schedule!O1:V1', [['排名', '隊伍名稱', '勝', '敗', '和', '勝局數', '勝隊加分', '總積分']], sheet_id=DST)
s.write('schedule!K1:K1', [['(未使用)']], sheet_id=DST)
# 舊的 Y:Z 排序輔助欄只算 6 隊，清掉避免誤用
s.write(f'schedule!Y2:Z{n}', [['', '']] * (n - 1), sheet_id=DST)

print('\n完成：', [sh['properties']['title'] for sh in s.meta(DST)['sheets']])
