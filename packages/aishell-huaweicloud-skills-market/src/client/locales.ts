/**
 * Locale dictionaries for the Huawei Cloud skills market tab.
 *
 * zh is the key-set source of truth and en mirrors it, the convention every
 * other package in this repository follows.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/client/locales
 */

/** Dictionary namespace owned by this plugin, and the tab entry's id. */
export const NS = 'aishell-huaweicloud-skills-market'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tab.label': '华为云技能',

  'page.title': '华为云技能',
  'page.subtitle': '华为云官方技能，安装后可在对话中按需调用',

  'search.placeholder': '搜索技能名称或描述',
  'search.clear': '清除搜索',
  'filter.all': '全部',
  'filter.label': '按分类筛选',
  'filter.install': '按安装状态筛选',
  'filter.install.all': '全部 {count}',
  'filter.install.installed': '已安装 {count}',
  'filter.install.available': '未安装 {count}',

  'action.refresh': '刷新',
  'action.refreshing': '正在刷新…',
  'action.install': '安装',
  'action.installing': '正在安装…',
  'action.uninstall': '卸载',
  'action.uninstalling': '正在卸载…',
  'action.installed': '已安装',
  'action.back': '返回列表',
  'action.openSource': '在 GitHub 查看',
  'action.cancel': '取消',
  'action.copy': '复制',
  'action.copied': '已复制',

  'detail.documentTitle': '技能说明',
  'detail.codeBlock': '代码块',
  'detail.wrap': '自动换行',
  'detail.unwrap': '取消自动换行',
  'detail.footnotes': '脚注',

  'state.loading': '正在获取技能列表…',
  'state.loadingHint': '首次进入需要下载一次技能仓库，请稍候',
  'state.empty': '没有匹配的技能',
  'state.emptyHint': '换个关键词，或清除筛选条件',
  'state.failed': '无法获取技能列表',
  'state.retry': '重试',

  'installed.note': '已安装到本机。新会话即可使用，当前会话下一轮也会看到。',

  'count.skills': '共 {count} 个技能',
  'count.filtered': '筛选出 {count} 个',
  'count.paged': '第 {page}/{pages} 页',
  'pager.label': '分页',
  'pager.previous': '上一页',
  'pager.next': '下一页',
  'pager.status': '{page} / {pages}',

  'error.name-taken': '同名技能已存在，且不是从市场安装的，因此没有覆盖它。',
  'error.not-installed-here': '这个技能不是从市场安装的，因此没有删除它。',
  'error.write-failed': '写入失败，请检查目录权限。',
  'error.catalog-unavailable': '无法连接到技能仓库。',
  'error.unknown-skill': '目录里找不到这个技能，可能上游已经移除。',
} as const

/** English dictionary. */
export const en = {
  'tab.label': 'HuaweiCloud Skills',

  'page.title': 'HuaweiCloud Skills',
  'page.subtitle': "Huawei Cloud's official skills, callable from a conversation once installed",

  'search.placeholder': 'Search by name or description',
  'search.clear': 'Clear search',
  'filter.all': 'All',
  'filter.label': 'Filter by category',
  'filter.install': 'Filter by install state',
  'filter.install.all': 'All {count}',
  'filter.install.installed': 'Installed {count}',
  'filter.install.available': 'Not installed {count}',

  'action.refresh': 'Refresh',
  'action.refreshing': 'Refreshing…',
  'action.install': 'Install',
  'action.installing': 'Installing…',
  'action.uninstall': 'Uninstall',
  'action.uninstalling': 'Uninstalling…',
  'action.installed': 'Installed',
  'action.back': 'Back to list',
  'action.openSource': 'View on GitHub',
  'action.cancel': 'Cancel',
  'action.copy': 'Copy',
  'action.copied': 'Copied',

  'detail.documentTitle': 'Skill instructions',
  'detail.codeBlock': 'Code block',
  'detail.wrap': 'Wrap lines',
  'detail.unwrap': 'Unwrap lines',
  'detail.footnotes': 'Footnotes',

  'state.loading': 'Loading skills…',
  'state.loadingHint': 'The first visit downloads the skill repository once',
  'state.empty': 'No matching skills',
  'state.emptyHint': 'Try another search, or clear the filters',
  'state.failed': 'Could not load the skill list',
  'state.retry': 'Retry',

  'installed.note': 'Installed. Available in new sessions, and in the next step of this one.',

  'count.skills': '{count} skills',
  'count.filtered': '{count} matching',
  'count.paged': 'Page {page} of {pages}',
  'pager.label': 'Pagination',
  'pager.previous': 'Previous',
  'pager.next': 'Next',
  'pager.status': '{page} / {pages}',

  'error.name-taken': 'A skill with this name already exists and was not installed from the market, so it was left untouched.',
  'error.not-installed-here': 'This skill was not installed from the market, so it was left untouched.',
  'error.write-failed': 'Writing failed. Check the directory permissions.',
  'error.catalog-unavailable': 'Could not reach the skill repository.',
  'error.unknown-skill': 'No such skill in the catalogue; upstream may have removed it.',
} as const

/** All keys, derived from the zh dictionary. */
export type SkillsMarketLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'aishell-huaweicloud-skills-market': SkillsMarketLocaleKey
  }
}