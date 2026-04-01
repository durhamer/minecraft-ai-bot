# Player2 App 整合說明

## 什麼是 Player2
[Player2](https://player2.game) 是一個本地 AI 遊戲平台，下載 App 後會在本機啟動一個 OpenAI 相容的 API server。
用戶在 App 裡選好模型（目前：Gemini 3 Flash），API 會代理到該模型。

## API 基本資訊
- Base URL：`http://127.0.0.1:4315/v1`（App 開啟時才有效）
- 注意：`localhost:4315` 因 IPv6 衝突無法用，只能用 `127.0.0.1`
- Chat endpoint：`POST /v1/chat/completions`（OpenAI 格式）
- request 裡的 `model` 欄位會被忽略，App 用自己選的模型

## 認證
- 本地 API 不需要 API key（`apiKey: ""`）
- 需要用戶已在 Player2 App 登入（有 joules 餘額）

## mindcraft 設定（profiles/player2.json）
```json
{
    "name": "Player2Bot",
    "model": "vllm/gemini-flash",
    "url": "http://127.0.0.1:4315/v1",
    "embedding": "none"
}
```
- `vllm/` 前綴讓 mindcraft 用 VLLM class（OpenAI 相容客戶端）
- `url` 欄位需要 prompter.js 的 bug fix 才會生效（見下）

## 已修 Bug：prompter.js url 未傳遞
`src/models/prompter.js` 原本只傳 model 字串給 `selectAPI()`，導致 `url` 欄位被丟棄、fallback 到 `0.0.0.0:8000`。
已改為傳完整物件：
```js
selectAPI({model: this.profile.model, url: this.profile.url, params: this.profile.params})
```
同樣修法套用在 `code_model` 和 `vision_model`。

## 啟動順序
1. 開啟 Player2 App（確認模型已選好、已登入）
2. `node main.js`
