/**
 * aishell credentials locale dictionaries.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'aishell' as const

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // Composer chip.
  'account.unconfigured': '未配置凭据',
  'mode.readonly': '只读',
  'mode.readwrite': '读写',
  'mode.unavailable': '权限模式不可用',
  'mode.readonly.hint': '当前：只读 — 只允许查询云资源，点击切换为读写',
  'mode.readwrite.hint': '当前：读写 — 允许变更云资源，点击切换为只读',
  'mode.unavailable.hint': '无法读取权限模式；切换按钮暂不可用',
  'mode.switchToReadonly': '切换为只读模式',
  'mode.switchToReadwrite': '切换为读写模式',

  // The read-write risk gate — shown before the mode escalates.
  'mode.confirm.title': '确认切换为读写模式？',
  'mode.confirm.description':
    '切换为读写后，智能体可以直接变更你的华为云账号，包括：创建、修改和删除云资源；'
    + '变更安全组、网络与权限配置，可能导致服务中断；'
    + '按实际用量产生费用，资源在销毁前会持续计费；'
    + '被删除的资源通常无法恢复。',
  'mode.confirm.acknowledge': '我已了解上述影响，并愿意继续',
  'mode.confirm.cancel': '保持只读',
  'mode.confirm.enable': '切换为读写',
  'mode.confirm.close': '关闭',

  // Credential form — hint and field copy shared by both entry paths.
  'section.credentials.hint.prefix': '建议从',
  'section.credentials.hint.link': 'API Explorer',
  'section.credentials.hint.suffix': '获取临时凭据，避免使用永久凭据。',
  'section.credentials.saving': '保存中…',

  // The credential card. Two states — signed out shows both ways to obtain a
  // credential, signed in shows the account and the way out. See
  // `./CredentialRequestForm.tsx` for why it is one card and not four pages.
  'form.title': '华为云 IAM 认证',
  'form.or': '或者',
  'form.signedIn': '已登录',
  'form.confirm': '确认',
  'form.logout': '退出',

  // Signed out — the browser route. Its button carries the route's whole
  // status, so these labels are what the person reads instead of a separate
  // waiting page.
  'form.browser.section': '选项一：浏览器登录',
  'form.browser.action': '登录',
  'form.browser.checking': '环境检测中…',
  'form.browser.unsupported': '当前环境不支持该方式。',
  'form.browser.cancelLabel': '取消登录',
  // The two words held inside the dial's ring. Short on purpose: the ring is
  // narrow, and a sentence would either overflow it or force the ring wide
  // enough to stop reading as a dial. The countdown sits under the ring as
  // `m:ss` — see `formatCountdown` for why it is not spelled out.
  'form.browser.runningLabel': '登录中',
  'form.browser.notOpened': '若浏览器未自动打开，请',
  // A link, not a clipboard action. A real link is one click, and it hands the
  // navigation to the browser — which is also why a popup blocker cannot refuse
  // it: the person is following a link rather than having a window opened for
  // them.
  //
  // Split into THREE keys because only the middle one is inside the anchor:
  // the sentence reads "若浏览器未自动打开，请[点击此处]打开。" and the verb after
  // the link is ordinary text. Putting it in the anchor would underline a word
  // that is not itself the link, which reads as a mistake. The trailing
  // punctuation is its own key for the same reason a literal would be wrong:
  // a full stop is `。` in Chinese and `.` in English.
  'form.browser.openHere': '点击此处',
  'form.browser.openHereSuffix': '打开。',
  'form.browser.failed': '浏览器登录未完成。',
  'form.browser.startFailed': '无法启动浏览器登录，请改用 AK/SK 或稍后重试。',
  'form.browser.expired': '登录超时，请重试。',

  // Signed out — the AK/SK route.
  'form.manual.section': '选项二：配置 AK/SK',
  'form.prefilledFromEnv': '已填入检测到的环境变量',
  'form.submit': '提交',
  'form.dismiss': '取消',
  'form.failed': '保存凭据失败',
  'form.clearing': '清除中…',
  'form.clear.failed': '清除凭据失败',
  // Transport failures surfaced by the save/clear routes. Displayed verbatim
  // in the card's error row, so they are user copy like everything else here.
  'error.unreachable': '无法连接宿主凭据服务：',

  // Field labels: the credential terms stay in English (AK/SK/Token are the
  // vocabulary users see in the Huawei Cloud console); only the parenthetical
  // qualifiers are localized.
  'section.field.accessKey': 'Access Key',
  'section.field.accessKey.placeholder': '华为云 Access Key',
  'section.field.accessKey.hint':
    'Access Key 与 Secret Key 须同时填写，只填其一时不会保存。',
  'section.field.secretKey': 'Secret Key',
  'section.field.secretKey.placeholder': '华为云 Secret Key',
  'section.field.secretKey.hint': '与 Access Key 配对使用，不在任何界面回显。',
  'section.field.token': 'Security Token（可选）',
  'section.field.token.placeholder': '华为云 Security Token',
  'section.field.token.hint': '仅临时凭据需要填写。',
} as const

/** English dictionary. */
export const en = {
  // Composer chip.
  'account.unconfigured': 'No credentials',
  'mode.readonly': 'Read-only',
  'mode.readwrite': 'Read-write',
  'mode.unavailable': 'Mode unavailable',
  'mode.readonly.hint': 'Read-only — cloud queries only. Click for read-write',
  'mode.readwrite.hint': 'Read-write — cloud changes allowed. Click for read-only',
  'mode.unavailable.hint': 'Could not read the permission mode; the toggle is unavailable',
  'mode.switchToReadonly': 'Switch to read-only mode',
  'mode.switchToReadwrite': 'Switch to read-write mode',

  // The read-write risk gate — shown before the mode escalates.
  'mode.confirm.title': 'Switch to read-write?',
  'mode.confirm.description':
    'In read-write mode the agent can change your Huawei Cloud account directly: '
    + 'create, modify and delete cloud resources; '
    + 'change security groups, networking and permission settings, which can interrupt running services; '
    + 'incur charges based on actual usage, with resources billed until they are destroyed; '
    + 'and delete resources that usually cannot be recovered. ',
  'mode.confirm.acknowledge': 'I understand these impacts and want to continue',
  'mode.confirm.cancel': 'Stay read-only',
  'mode.confirm.enable': 'Switch to read-write',
  'mode.confirm.close': 'Close',

  // Credential form — hint and field copy shared by both entry paths.
  'section.credentials.hint.prefix': 'Obtain temporary credentials from',
  'section.credentials.hint.link': 'API Explorer',
  'section.credentials.hint.suffix': 'and avoid permanent ones.',
  'section.credentials.saving': 'Saving…',

  // The credential card — see the Chinese dictionary.
  'form.title': 'Huawei Cloud IAM authentication',
  'form.or': 'or',
  'form.signedIn': 'Signed in',
  'form.confirm': 'Confirm',
  'form.logout': 'Logout',

  // Signed out — the browser route.
  'form.browser.section': 'Option 1: sign in with a browser',
  'form.browser.action': 'Sign in',
  'form.browser.checking': 'Checking this environment…',
  'form.browser.unsupported': 'This environment does not support this method.',
  'form.browser.cancelLabel': 'Cancel sign-in',
  'form.browser.runningLabel': 'Signing in',
  'form.browser.notOpened': 'If the browser did not open, ',
  // Only `openHere` sits inside the anchor; the words after it are plain text.
  // The leading space is part of the suffix and not of the JSX, because the
  // separator between an anchor and following text is `nothing` in Chinese and
  // `one space` in English — a space written in the JSX would show as a gap
  // before the Chinese full stop.
  'form.browser.openHere': 'click here',
  'form.browser.openHereSuffix': ' to open it.',
  'form.browser.failed': 'The browser sign-in did not complete.',
  'form.browser.startFailed': 'Could not start the browser sign-in. Use an AK/SK instead, or try again.',
  'form.browser.expired': 'The sign-in timed out. Try again.',

  // Signed out — the AK/SK route.
  'form.manual.section': 'Option 2: configure an AK/SK',
  'form.prefilledFromEnv': 'Filled in from detected environment variables',
  'form.submit': 'Submit',
  'form.dismiss': 'Cancel',
  'form.failed': 'Could not save credentials',
  'form.clearing': 'Clearing…',
  'form.clear.failed': 'Could not clear credentials',
  'error.unreachable': 'Could not reach the host credential service: ',

  // Field labels.
  'section.field.accessKey': 'Access Key',
  'section.field.accessKey.placeholder': 'Huawei Access Key',
  'section.field.accessKey.hint':
    'Access Key and Secret Key are stored as a pair; one without the other is not saved.',
  'section.field.secretKey': 'Secret Key',
  'section.field.secretKey.placeholder': 'Huawei Secret Key',
  'section.field.secretKey.hint': 'Used together with the Access Key; never displayed again.',
  'section.field.token': 'Security Token (optional)',
  'section.field.token.placeholder': 'Huawei Security Token',
  'section.field.token.hint': 'Required only for temporary credentials.',
} as const

/** All keys (derived from the zh dictionary, the source of truth). */
export type AishellLocaleKey = keyof typeof zh

// Merge the `aishell` namespace into the framework's LocaleNamespaceMap so
// PropsLocale<'aishell'> resolves to a typed `t` at compile time.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    aishell: AishellLocaleKey
  }
}
