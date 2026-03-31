# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VoiceDoc Flow — スマートフォンブラウザで会議を録音（またはファイルアップロード）し、Gemini APIで議事録を自動生成、Google Docsに保存してGmailで送信する単一ユーザー向けWebアプリ。

- **利用者**: 開発者1名のみ（パスワード認証）
- **業界**: 工作機械販売（旋盤・マシニングセンタ・NC等）
- **コスト**: GAS無料枠 + Gemini API従量課金（Google AI Pro契約とは別途）

## Architecture

```
[GitHub Pages: index.html]
    └─ GAS doPost（audioData: base64送信）
           ├─ Gemini generateContent（inlineData で議事録生成）
           ├─ Google Drive 1_rec（録音ファイル保存）
           ├─ Google Drive 2_doc（Googleドキュメント保存）
           └─ Gmail（送信）
```

**フロントエンドはGitHub Pages**（`https://porfelam-cmd.github.io/voicedocflow/`）で配信。
GASのHtmlServiceはiframeでマイクをブロック、ContentServiceはGoogle認証済みユーザーにソースを表示するため、GAS経由のHTML配信は不使用。

**音声はbase64でGASに直送**。GAS doPostの上限約10MB（base64換算で生音声〜7.5MB）。32kbpsで録音すると約30分が上限。

### Data Flow

1. PWA → 録音（MediaRecorder、32kbps）またはファイル選択（MP3/M4A/WAV/WebM/OGG）
2. フロント側でMIMEタイプを正規化（`normalizeMimeType()`）してbase64変換
3. PWA → GAS `doPost`: `{ action, password, audioData, mimeType }` を `Content-Type: text/plain` で送信
4. GAS → Gemini `generateContent`: `inlineData` で議事録JSON生成
5. GAS → Drive `1_rec`: 録音ファイルを保存（`[YYYYMMDD_HHmm]_[会社名]_[議題].[ext]`）
6. GAS → Drive `2_doc`: Googleドキュメントを保存（`[YYYYMMDD]_[会社名]_[議題]`）
7. GAS → Gmail: 要約 + DocURL を固定宛先に送信

## Deployment

ビルドステップ・テストコマンドなし。変更手順：

- `index.html` → `git push origin main` → GitHub Pagesに自動反映（数分）
- `Code.gs` → GASエディタにコピー → 「デプロイを管理」→「新バージョン」でデプロイ

**重要**: コード変更時はローカルファイルとGASエディタを必ず両方更新する。

## GAS Configuration

スクリプトプロパティ（GASエディタ > プロジェクトの設定 > スクリプトプロパティ）:

| キー | 内容 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio APIキー（課金設定済みプロジェクト） |
| `RECIPIENT_EMAIL` | 議事録送信先メール（固定） |
| `DRIVE_FOLDER_ID` | 議事録保存先DriveフォルダID（`2_doc`） |
| `DRIVE_REC_FOLDER_ID` | 録音保存先DriveフォルダID（`1_rec`） |
| `APP_PASSWORD` | パスワードゲート認証用パスワード |

デプロイ設定: **「自分として実行」** / **「全員（Googleアカウント不要）」**

## GAS Endpoints

`doPost(e)` のみ。ボディ: `{ action: 'process', password, audioData, mimeType }`

- パスワード不一致 → `{ success: false, error: 'Unauthorized' }`
- 成功 → `{ success: true, docUrl }`
- 失敗 → `{ success: false, error: メッセージ }`

## Gemini

- モデル: `gemini-2.5-flash`（`gemini-2.0-flash` 系は新規ユーザー向けに廃止済み）
- `temperature: 0.2`、`maxOutputTokens: 8192`、`responseMimeType: 'application/json'`
- 出力スキーマ（`transcript` は不要なため除外）:

```json
{
  "title": "会議タイトル（15字以内）",
  "company": "会社名",
  "topic": "議題キーワード（10字以内・記号なし）",
  "participants": ["名前1"],
  "decisions": ["決定事項1"],
  "actions": [{ "item": "タスク", "assignee": "担当者", "deadline": "期限" }],
  "summary": "構造化サマリー（日本語）"
}
```

## Google Docs構成

ファイル名: `[YYYYMMDD]_[会社名]_[議題]`（`2_doc` フォルダに保存）
日時はGAS処理時刻（`Asia/Tokyo`、曜日付き）を使用。

```
H1: タイトル
H2: 基本情報     → 日時（例: 2026年03月31日（火） 11:01）・参加者
H2: 決定事項     → 箇条書き
H2: 今後の対応   → 表（タスク / 担当者 / 期限）
H2: 要約
```

## Frontend (index.html)

### 画面構成

1. **パスワードゲート** (`#screen-gate`) — 迷路SVG背景（反復DFS）+ ダブルボーダーロゴ
2. **メインアプリ** (`#screen-app`)
   - パネル①: 録音（タイマー + 録音ボタン）＋ ファイルアップロード
   - パネル②: 処理中（3ステップ進捗）
   - パネル③: 完了（Google Docsリンク）
   - パネル④: エラー（やり直しボタン）

### 音声入力

**録音**: MediaRecorder（32kbps）、MIMEタイプ優先順: `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` → `audio/mp4`

**ファイルアップロード**: `<input type="file" accept="audio/*">` で選択後、`normalizeMimeType()` でGemini対応形式に変換

| 入力MIME | 正規化後 |
|---|---|
| `audio/mpeg`, `audio/mp3` | `audio/mp3` |
| `audio/mp4`, `audio/x-m4a`, `video/mp4` | `audio/mp4` |
| `audio/x-wav`, `audio/wave` | `audio/wav` |
| `video/webm`, `audio/webm` | `audio/webm` |
| `video/ogg`, `audio/ogg` | `audio/ogg` |

### JS定数

```js
const GAS_URL = 'https://script.google.com/macros/s/.../exec';
```

パスワードはGAS側で検証。入力値をそのままGASに送信するだけ。

## UI Design Rules

**カラー**（青・紫・オレンジ禁止）:

| 用途 | 値 |
|---|---|
| プライマリ | `#111827` |
| ホバー | `#000000` |
| 背景 | `#F5F4EF` |
| 成功 | `#059669` |
| エラー | `#DC2626` |
| 境界線 | `#D1D5DB` |

- 角丸: 入力・ボタン `12px`、カード `16px`、モーダル `24px`
- タッチターゲット最小: 48px
- フォント: `-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', sans-serif`

## Key Constraints

- GASタイムアウト6分以内に完結させること
- 音声base64のGAS送信上限: 約30分（32kbps時）。超えるとリクエストサイズ超過で失敗
- Gemini APIの課金はGoogle AI Pro契約とは別途必要
- `gemini-2.0-flash` 系は新規ユーザー向けに廃止。`gemini-2.5-flash` 以降を使うこと
- APIキーをコードやGitHubに含めない。GASスクリプトプロパティのみで管理
