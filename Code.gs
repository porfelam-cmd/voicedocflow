// ============================================================
// VoiceDoc Flow — Code.gs
// ============================================================
// スクリプトプロパティ（GASエディタで設定）:
//   GEMINI_API_KEY      : Google AI Studio APIキー
//   RECIPIENT_EMAIL     : 議事録送信先メールアドレス
//   DRIVE_FOLDER_ID     : 議事録保存先DriveフォルダID（2_doc）
//   DRIVE_REC_FOLDER_ID : 録音保存先DriveフォルダID（1_rec）
//   APP_PASSWORD        : パスワードゲート認証用パスワード
// ============================================================

// ------------------------------------------------------------
// doGet — index.html を ContentService で直接配信
// Phase 1 ではプレースホルダーを返す。Phase 2 で本体に差し替える。
// キャッシュ無効化は index.html の <meta http-equiv="Cache-Control"> で対応。
// ------------------------------------------------------------
function doGet() {
  var html = HtmlService.createHtmlOutputFromFile('index').getContent();
  return ContentService.createTextOutput(html)
    .setMimeType(ContentService.MimeType.HTML);
}

// ------------------------------------------------------------
// doPost — メインエントリーポイント
// ------------------------------------------------------------
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // パスワード検証
    const props = PropertiesService.getScriptProperties();
    const correctPassword = props.getProperty('APP_PASSWORD');
    if (!correctPassword || body.password !== correctPassword) {
      return jsonResponse({ success: false, error: 'Unauthorized' });
    }

    if (body.action === 'process') {
      return handleProcess(body);
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + body.action });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ------------------------------------------------------------
// handleProcess — 議事録生成のメインフロー
// ------------------------------------------------------------
function handleProcess(body) {
  const { audioData, mimeType } = body;
  if (!audioData || !mimeType) {
    return jsonResponse({ success: false, error: 'audioData and mimeType are required' });
  }

  const props = PropertiesService.getScriptProperties();
  const geminiKey      = props.getProperty('GEMINI_API_KEY');
  const recipientEmail = props.getProperty('RECIPIENT_EMAIL');
  const driveFolderId  = props.getProperty('DRIVE_FOLDER_ID');
  const recFolderId    = props.getProperty('DRIVE_REC_FOLDER_ID');

  // 1. 議事録生成（インラインデータで直接送信）
  const minutes = generateMinutes(audioData, mimeType, geminiKey);

  // 2. 録音ファイルを 1_rec に保存
  if (recFolderId) {
    saveAudioToDrive(audioData, mimeType, minutes, recFolderId);
  }

  // 3. Google ドキュメントを 2_doc に保存
  const docUrl = saveToDoc(minutes, driveFolderId);

  // 4. Gmail 送信
  sendEmail(minutes, docUrl, recipientEmail);

  return jsonResponse({ success: true, docUrl: docUrl });
}

// ============================================================
// Drive — 録音ファイル保存（1_rec）
// ============================================================
function saveAudioToDrive(audioData, mimeType, minutes, recFolderId) {
  const now     = new Date();
  const dateStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  const company = minutes.company || '不明';
  const topic   = minutes.topic   || '録音';

  var ext = '.webm';
  if (mimeType.indexOf('ogg') !== -1) ext = '.ogg';
  else if (mimeType.indexOf('mp4') !== -1) ext = '.mp4';

  const fileName   = '[' + dateStr + ']_' + company + '_' + topic + ext;
  const audioBytes = Utilities.base64Decode(audioData);
  const blob       = Utilities.newBlob(audioBytes, mimeType, fileName);

  DriveApp.getFolderById(recFolderId).createFile(blob);
}

// ============================================================
// Gemini — 議事録生成（インラインデータ）
// ============================================================
function generateMinutes(audioData, mimeType, geminiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;

  const prompt = [
    'あなたは工作機械販売業界の会議の議事録作成の専門家です。',
    '添付の音声を文字起こしし、議事録を作成してください。',
    '',
    '【重要】工作機械業界の専門用語を正確に認識・記録してください。',
    '例: 旋盤、マシニングセンタ、NC旋盤、立型・横型、型番、切削条件、',
    '    送り速度、回転数、工具径、チャック、心押し台、ATC、パレットチェンジャー等',
    '',
    '以下のJSON形式のみで出力してください（説明文・コードブロック不要）:',
    '{',
    '  "title": "会議タイトル（15字以内）",',
    '  "company": "会社名",',
    '  "topic": "議題キーワード（10字以内・記号なし）",',
    '  "participants": ["参加者名"],',
    '  "decisions": ["決定事項"],',
    '  "actions": [{ "item": "タスク内容", "assignee": "担当者", "deadline": "期限" }],',
    '  "summary": "構造化されたサマリー（日本語・詳細）"',
    '}'
  ].join('\n');

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType, data: audioData } }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());

  if (!data.candidates || !data.candidates[0]) {
    throw new Error('Gemini returned no candidates. Response: ' + res.getContentText().substring(0, 500));
  }

  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

// ============================================================
// Google Docs — 議事録保存
// ============================================================
function saveToDoc(minutes, driveFolderId) {
  const now     = new Date();
  const dateStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  const company = minutes.company || '不明';
  const topic   = minutes.topic   || '議事録';
  const fileName = '[' + dateStr + ']_' + company + '_' + topic;

  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const dayOfWeek  = DAY_NAMES[now.getDay()];
  const datetimeStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy年MM月dd日') +
                      '（' + dayOfWeek + '） ' +
                      Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');

  const doc  = DocumentApp.create(fileName);
  const body = doc.getBody();

  // H1: タイトル
  body.appendParagraph(minutes.title || fileName)
    .setHeading(DocumentApp.ParagraphHeading.HEADING1);

  // H2: 基本情報
  body.appendParagraph('基本情報')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('日時: ' + datetimeStr);
  body.appendParagraph('参加者: ' + (minutes.participants || []).join('、'));

  // H2: 決定事項
  body.appendParagraph('決定事項')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  (minutes.decisions || []).forEach(function(d) {
    body.appendListItem(d).setGlyphType(DocumentApp.GlyphType.BULLET);
  });

  // H2: 今後の対応
  body.appendParagraph('今後の対応')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  const actions = minutes.actions || [];
  if (actions.length > 0) {
    const table  = body.appendTable();
    const header = table.appendTableRow();
    header.appendTableCell('タスク');
    header.appendTableCell('担当者');
    header.appendTableCell('期限');
    actions.forEach(function(a) {
      const row = table.appendTableRow();
      row.appendTableCell(a.item     || '');
      row.appendTableCell(a.assignee || '');
      row.appendTableCell(a.deadline || '');
    });
  }

  // H2: 要約
  body.appendParagraph('要約')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(minutes.summary || '');

  doc.saveAndClose();

  // 指定フォルダに移動（デフォルトはマイドライブ直下に作られるため）
  const file   = DriveApp.getFileById(doc.getId());
  const folder = DriveApp.getFolderById(driveFolderId);
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  return doc.getUrl();
}

// ============================================================
// Gmail — 送信
// ============================================================
function sendEmail(minutes, docUrl, recipientEmail) {
  const subject = '【議事録】' + (minutes.title || '会議議事録');

  const decisionsText = (minutes.decisions || [])
    .map(function(d) { return '・' + d; }).join('\n');

  const actionsText = (minutes.actions || [])
    .map(function(a) {
      return '・' + a.item + '（' + a.assignee + ' / ' + a.deadline + '）';
    }).join('\n');

  const bodyText = [
    '議事録が作成されました。',
    '',
    '■ タイトル: ' + (minutes.title || ''),
    '■ 日時: '     + (minutes.datetime || ''),
    '■ 参加者: '   + (minutes.participants || []).join('、'),
    '',
    '■ 決定事項:',
    decisionsText || '（なし）',
    '',
    '■ ネクストアクション:',
    actionsText || '（なし）',
    '',
    '■ Google Docs URL:',
    docUrl
  ].join('\n');

  GmailApp.sendEmail(recipientEmail, subject, bodyText);
}

// ============================================================
// ユーティリティ
// ============================================================
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
