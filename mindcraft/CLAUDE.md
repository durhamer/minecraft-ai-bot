# Minecraft AI Bot Project Rules

## 核心開發原則
1. **精簡高效**：給出的程式碼與解釋請直接切入重點。這是一個注重 token 成本的專案。
2. **解釋原理**：修改程式碼時，請簡略說明「為什麼」這樣改，而不只是給 code。
3. **除錯彈性（重要）**：若 trace code 發現實際邏輯與下方認知衝突，**直接讀原始碼糾正**，不要盲從這些假設。

## 技術環境
- OS: macOS (M2 Pro, Apple Silicon)
- Node.js: v22.11.0（請勿升級，會有原生模組 ABI 版本衝突）
- Java: 17 (Temurin) / Minecraft: 1.21.4 (LAN World)
- LLM: 支援本機 Ollama (andy-4:micro-q8_0) 或雲端 API

## 架構認知（已驗證）

**兩個不同的 profile 概念：**
- `settings.js → profiles`：要啟動哪些 bot，每個指向一個個體 profile JSON（主要差異是 `model` 和 `name`）
- `settings.js → base_profile`：決定行為模式（hunting、self_preservation 等），對應 `profiles/defaults/` 裡的 survival / assistant / creative / god_mode

**優先級（見 `src/models/prompter.js:34-43`）：**
個體 profile (andy.json) > base_profile > _default.json
base_profile 只填補個體 profile 未定義的欄位，不覆蓋已有設定。

**其他：**
- `keys.json` 存放敏感金鑰，絕對不可加入 git 追蹤
- `allow_vision: false` 時 `vision_interpreter.js` 採用 lazy import 載入 `camera.js`（避開 node-canvas-webgl ABI 衝突）
