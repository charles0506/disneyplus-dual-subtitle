# Disney+ 雙字幕＋字幕放大

Disney+ 網頁版字幕放大，並在原字幕上方加第二語言字幕
（原字幕中文 → 加英文；原字幕英文 → 加繁中）。

安裝：https://raw.githubusercontent.com/charles0506/disneyplus-dual-subtitle/main/disneyplus-dual-subtitle.user.js

先在 Disney+ 播放器選好原字幕（例如中文），腳本會自動抓另一語言。

快捷鍵（播放時）：

- Alt + = / Alt + -：字幕放大／縮小（預設 140%）
- Alt + S：第二字幕開／關
- Alt + L：切換第二字幕語言
- Alt + D：顯示狀態（偵測到的字幕軌、時間差校正）

做法：側錄頁面載入的 HLS 清單與 WebVTT 字幕分段，自己抓另一語言整軌，
用原字幕出現時刻比對文字來校正時間差，再疊在原字幕上方。
