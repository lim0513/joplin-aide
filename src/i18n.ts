// i18n strings for Joplin Claude. Follows Joplin's locale setting.
// Only USER-FACING text lives here - messages addressed to the model
// (tool results, deny reasons) stay English in index.ts.

export interface I18nStrings { [key: string]: string; }

export const i18nData: { [locale: string]: I18nStrings } = {
  'en_US': {
    inputPlaceholder: 'Ask Claude about your notes...',
    titleHistory: 'History',
    titleNew: 'New conversation',
    titleSend: 'Send',
    titleStop: 'Stop',
    titleDelete: 'Delete',
    working: '⏳ Claude is working...',
    noHistory: 'No history yet',
    approve: 'Approve',
    decline: 'Decline',
    errAlreadyRunning: 'A request is already running.',
    errStartFailed: 'Failed to start claude: {err}',
    errProcess: 'claude process error: {err}. Is the Claude Code CLI installed and on PATH? (Settings > Joplin Claude)',
    errExited: 'claude exited with code {code}: {err}',
    cCreateNote: 'Create note "{title}"',
    cUpdateNote: 'Update note {id}',
    cRetitle: ' (retitle to "{title}")',
    cBodyChars: ' [body: {n} chars]',
    cCreateNotebook: 'Create notebook "{title}"',
    cDeleteNote: 'DELETE note {id}',
    cToolPermission: 'Tool permission: {name}',
    dCreated: 'Created note: {title}',
    dUpdated: 'Updated note {id}',
    dDeleted: 'Deleted note {id}',
    autoApproved: '⚠ Auto-approved: {s}',
  },
  'zh_CN': {
    inputPlaceholder: '向 Claude 询问你的笔记...',
    titleHistory: '历史会话',
    titleNew: '新会话',
    titleSend: '发送',
    titleStop: '停止',
    titleDelete: '删除',
    working: '⏳ Claude 正在处理...',
    noHistory: '暂无历史会话',
    approve: '允许',
    decline: '拒绝',
    errAlreadyRunning: '已有请求正在运行。',
    errStartFailed: '启动 claude 失败：{err}',
    errProcess: 'claude 进程错误：{err}。请确认已安装 Claude Code CLI 且在 PATH 中（设置 > Joplin Claude）。',
    errExited: 'claude 退出，代码 {code}：{err}',
    cCreateNote: '新建笔记「{title}」',
    cUpdateNote: '修改笔记 {id}',
    cRetitle: '（改名为「{title}」）',
    cBodyChars: '（正文 {n} 字符）',
    cCreateNotebook: '新建笔记本「{title}」',
    cDeleteNote: '删除笔记 {id}',
    cToolPermission: '工具权限请求：{name}',
    dCreated: '已创建笔记：{title}',
    dUpdated: '已修改笔记 {id}',
    dDeleted: '已删除笔记 {id}',
    autoApproved: '⚠ 已自动批准：{s}',
  },
  'ja_JP': {
    inputPlaceholder: 'ノートについて Claude に質問...',
    titleHistory: '履歴',
    titleNew: '新しい会話',
    titleSend: '送信',
    titleStop: '停止',
    titleDelete: '削除',
    working: '⏳ Claude が処理中...',
    noHistory: '履歴はまだありません',
    approve: '許可',
    decline: '拒否',
    errAlreadyRunning: 'リクエストがすでに実行中です。',
    errStartFailed: 'claude の起動に失敗しました：{err}',
    errProcess: 'claude プロセスエラー：{err}。Claude Code CLI がインストールされ PATH にあるか確認してください（設定 > Joplin Claude）。',
    errExited: 'claude がコード {code} で終了：{err}',
    cCreateNote: 'ノート「{title}」を作成',
    cUpdateNote: 'ノート {id} を更新',
    cRetitle: '（「{title}」に改名）',
    cBodyChars: '（本文 {n} 文字）',
    cCreateNotebook: 'ノートブック「{title}」を作成',
    cDeleteNote: 'ノート {id} を削除',
    cToolPermission: 'ツール権限リクエスト：{name}',
    dCreated: 'ノートを作成：{title}',
    dUpdated: 'ノート {id} を更新しました',
    dDeleted: 'ノート {id} を削除しました',
    autoApproved: '⚠ 自動許可：{s}',
  },
};

export function getI18n(locale: string): I18nStrings {
  if (i18nData[locale]) return i18nData[locale];
  const lang = String(locale || '').split('_')[0];
  if (lang === 'zh') return i18nData['zh_CN'];
  if (lang === 'ja') return i18nData['ja_JP'];
  return i18nData['en_US'];
}

export function fmt(template: string, vars: { [k: string]: any }): string {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}
