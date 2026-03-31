# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VoiceDoc Flow — スマートフォンブラウザで会議を録音し、Gemini APIで議事録を自動生成、Google Docsに保存してGmailで送信する単一ユーザー向けWebアプリ。

- **利用者**: 開発者1名のみ（パスワード認証）
- **想定録音**: 30〜60分
- **業界**: 工作機械販売（旋盤・マシニングセンタ・NC等）
- **コスト**: GAS無料枠 + Google AI Studio課金のみ

## Architecture

```
[ブラウザ PWA]
    ├─ Gemini File API（音声を直接アップロード → fileUri取得）
    └─ GAS doPost（fileUri送信）
           ├─ Gemini generateContent（議事録生成）
           ├─ Google Docs（議事録保存）
           └─ Gmail（送信）
```

**音声はGASに送らない**。30〜60分録音は14〜58MB。GASの10MB上限を超えるため、PWAからGemini File APIに直接アップロードし、返却された`fileUri`のみをGASに渡す。

### Data Flow

1. PWA → Gemini File API: Resumable Uploadで音声Blobを直接送信 → `fileUri`取得
2. PWA → GAS `doPost`: `{ action, password, fileUri, mimeType }` を送信（`Content-Type: text/plain` でCORSプリフライト回避）
3. GAS: `waitForFileActive(fileUri)` で最大60秒待機（3秒×20回）
4. GAS → Gemini `generateContent`: `fileUri`参照で議事録JSON生成
5. GAS → Google Drive: `[YYYYMMDD]_[会社名]_[議題].gdoc` として保存
6. GAS → Gmail: 要約 + DocURL を固定宛先に送信

## Deployment

このプロジェクトにはビルドステップやテストコマンドはない。GASプロジェクトのため：

- `Code.gs` → GASエディタにコピー＆ペースト
- `index.html` → GASエディタで同名ファイルとして追加
- デプロイ設定: **「自分として実行」** / **「全員（Googleアカウント不要）」**
- デプロイ後、発行URLを `index.html` 内の `GAS_URL` 定数に設定

## GAS Configuration

スクリプトプロパティ（GASエディタ > プロジェクトの設定 > スクリプトプロパティで設定）:

| キー | 内容 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio APIキー |
| `RECIPIENT_EMAIL` | 議事録送信先メール（固定） |
| `DRIVE_FOLDER_ID` | 保存先DriveフォルダID |
| `APP_PASSWORD` | パスワードゲート認証用パスワード |

## GAS Endpoints

`doPost(e)` のみ。ボディ: `{ action: 'process', password, fileUri, mimeType }`

- パスワード不一致 → `{ success: false, error: 'Unauthorized' }`
- 成功 → `{ success: true, docUrl }`
- 失敗 → `{ success: false, error: メッセージ }`

**注意**: 現在の `Code.gs` は `audioData`（inline base64）方式で実装されており、仕様（`fileUri`方式）と乖離している。`handleProcess` および `generateMinutes` の修正が必要。

## Frontend (index.html)

### 画面構成

1. **パスワードゲート** (`#screen-gate`) — 迷路SVG背景（反復DFS生成、`#C4C2B7`）+ ダブルボーダーロゴ + パスワード入力
2. **メインアプリ** (`#screen-app`)
   - パネル①: 録音（タイマー + 録音ボタン）
   - パネル②: 処理中（3ステップ進捗 + スピナー）
   - パネル③: 完了（タイトル + Google Docsリンク）
   - パネル④: エラー（メッセージ + やり直しボタン）

### 録音・送信フロー

1. `navigator.mediaDevices.getUserMedia({ audio: true })`
2. MIMEタイプ優先順: `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` → `audio/mp4`
3. Gemini Resumable Upload: `POST /upload/v1beta/files?uploadType=resumable` → `X-Goog-Upload-URL` ヘッダーからURL取得 → Blob送信 → `file.uri` 取得
4. GASへ: `fetch(GAS_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({...}), redirect:'follow' })`

### JS定数（index.html内）

```js
const GAS_URL     = 'https://script.google.com/macros/s/.../exec'; // デプロイ後に更新
const _GEMINI_KEY = 'AIzaSy...'; // Gemini File APIアップロード用
```

パスワードはGAS側で検証。フロントではユーザー入力値をそのままGASに送信するだけ。

## Gemini

- モデル: `gemini-2.5-pro`、`temperature: 0.2`、`maxOutputTokens: 8192`
- 出力スキーマ（`responseMimeType: 'application/json'`）:

```json
{
  "title": "会議タイトル（15字以内）",
  "company": "会社名",
  "topic": "議題キーワード（10字以内・記号なし）",
  "datetime": "推定日時",
  "participants": ["名前1"],
  "decisions": ["決定事項1"],
  "actions": [{ "item": "タスク", "assignee": "担当者", "deadline": "期限" }],
  "summary": "構造化サマリー（日本語）",
  "transcript": "全文書き起こし（日本語）"
}
```

プロンプトには工作機械業界用語（旋盤、マシニングセンタ、NC旋盤、型番、切削条件など）を優先的に拾い上げる指示を含めること。

## Google Docs構成

ファイル名: `[YYYYMMDD]_[会社名]_[議題]`

```
H1: タイトル
H2: Basic Info  → 日時・参加者
H2: Decisions   → 箇条書き
H2: Next Actions → 表（Task / Assignee / Deadline）
H2: Summary
H2: Full Transcript
```

## UI Design Rules

**カラー**（モノクロのみ。青・紫・オレンジ禁止）:

| 用途 | 値 |
|---|---|
| プライマリ | `#111827` (gray-900) |
| ホバー | `#000000` |
| 背景 | `#F5F4EF` (warm white) |
| 成功 | `#059669` (green-600) |
| エラー | `#DC2626` (red-600) |
| 境界線 | `#D1D5DB` (gray-300) |

**角丸**: 入力・ボタン `rounded-xl`(12px)、カード `rounded-2xl`(16px)、モーダル `rounded-3xl`(24px)

**その他**:
- フォント: `-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', sans-serif`
- タッチターゲット最小: 48px
- アニメーション: `fadein`(0.3s)、`pulse-ring`（録音中）、`spin`（スピナー）
- `<html translate="no">` + `<meta name="google" content="notranslate">`

## Key Constraints

- GASタイムアウト6分以内に完結させること
- 音声ファイルはGASに直送しない（サイズ制限超過）
- 追加の有料SaaS不使用
