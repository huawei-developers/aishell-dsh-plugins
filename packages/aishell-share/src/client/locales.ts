/**
 * Session-share dictionaries.
 *
 * Simplified Chinese is the key-set source of truth; English is complete
 * against it and is also the terminal fallback, so a locale other than `zh`
 * reads English.
 *
 * ## Voice
 *
 * These are product strings, not comments: each one is the sentence a person
 * reads in the card. Two rules hold them together.
 *
 * **Speak about the reader's material, not about the machinery.** "会话" is what
 * the reader shared; "包", "上传队列" and "接口" are how this package happens to
 * be built. A sentence that names the machinery tells them nothing they can act
 * on.
 *
 * **State what will happen, then stop.** The confirmation says what leaves the
 * machine and where it goes. It does not warn about what this plugin cannot
 * promise, and it does not repeat the title.
 *
 * ## Where a sentence ends
 *
 * Chinese ends a sentence with `。` flush against the last glyph, where English
 * wants a period after a space. Strings that a link or a number is spliced into
 * therefore carry their own trailing space in English and none in Chinese,
 * rather than relying on the markup to supply one.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/locales
 */

export const NS = 'aishell-share' as const

/** Simplified Chinese dictionary. */
export const zh = {
  'menu.share': '分享会话',
  // The tooltip on a Turn's action row. Short: it sits in a row of icon-only
  // buttons where every label is one or two words.
  'action.share': '分享以上对话',
  'dialog.title': '分享会话',
  'dialog.titleImport': '导入会话',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',

  // Sharing. The confirmation names what leaves the machine and where it goes,
  // and nothing else: the button the reader presses is the one that sends it.
  'share.disclosure':
    '将当前会话分享给其他人。对话记录会上传到服务器，并生成一个可以分享的链接。',
  'share.generating': '生成链接',
  'share.copied': '链接已复制',
  'share.linkLabel': '分享链接',
  'dialog.shareConfirm': '分享',
  'dialog.copy': '复制链接',

  // The Workspace menu row.
  'menu.importSession': '导入会话',

  // Importing.
  'import.loading': '加载会话',
  'import.linkLabel': '会话分享链接',
  'import.linkPlaceholder': '粘贴分享链接',
  'import.preview': '预览',
  'import.chooseWorkspace': '选择导入到哪个工作区',
  'import.browse': '选择其他文件夹…',
  'import.importing': '正在导入',
  'import.empty': '这个会话没有可显示的对话内容。',
  'dialog.import': '导入到本地',

  // Failures, one key per reason the Host can report.
  //
  // Some reasons mean different things to the two flows, so those carry a
  // `share.` or `import.` prefix. A reader who pressed Share has no link yet:
  // telling them "this link cannot be read" describes a link they do not hold.
  // "Try again later" is reserved for faults that can clear. A rejected package
// is the same package however many times it is sent — the service inspects the
// content and answers 400 every time — so that copy promises something the
// retry cannot deliver.
  'failure.share.rejected': '无法分享这个会话的内容。',
  'failure.import.rejected': '无法读取这个链接的内容。',
  'failure.unavailable': '链接已失效或不存在。',
  'failure.share.too-large': '会话过大，暂时无法分享。',
  'failure.import.too-large': '会话过大，暂时无法导入。',
  'failure.unavailable-service': '服务暂时不可用，请稍后重试。',
  'failure.import.bad-request': '请求无效，请重新打开链接。',
  'failure.share.bad-request': '请求无效，请稍后重试。',
} as const

/** English dictionary. */
export const en = {
  'menu.share': 'Share session',
  'action.share': 'Share conversation so far',
  'dialog.title': 'Share session',
  'dialog.titleImport': 'Import conversation',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',

  'share.disclosure':
    'Share this conversation with someone else. The conversation is uploaded '
    + 'to a server and turned into a link you can pass on.',
  'share.generating': 'Creating link',
  'share.copied': 'Link copied',
  'share.linkLabel': 'Share link',
  'dialog.shareConfirm': 'Share',
  'dialog.copy': 'Copy link',

  'menu.importSession': 'Import conversation',

  'import.loading': 'Loading',
  'import.linkLabel': 'Conversation link',
  'import.linkPlaceholder': 'Paste a share link',
  'import.preview': 'Preview',
  'import.chooseWorkspace': 'Choose where to import this conversation',
  'import.browse': 'Choose another folder…',
  'import.importing': 'Importing',
  'import.empty': 'This conversation has no messages to show.',
  'dialog.import': 'Import',

  'failure.share.rejected': 'This conversation’s contents could not be shared.',
  'failure.import.rejected': 'This link’s contents cannot be read.',
  'failure.unavailable': 'This link is no longer available.',
  'failure.share.too-large': 'This conversation is too large to share.',
  'failure.import.too-large': 'This conversation is too large to import.',
  'failure.unavailable-service': 'The service is unavailable. Try again later.',
  'failure.import.bad-request': 'That request was invalid. Open the link again.',
  'failure.share.bad-request': 'That request was invalid. Try again later.',
} as const

/** Every key, derived from the zh dictionary. */
export type AishellShareLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'aishell-share': AishellShareLocaleKey
  }
}