/**
 * aishell brand locale dictionaries.
 *
 * The brand plugin owns its own namespace rather than reusing `aishell`
 * (which `aishell-credentials` registers): a namespace's texts have exactly
 * one owner, and a duplicate `(ns, locale)` registration throws.
 *
 * ## Why content lives in a dictionary
 *
 * The suggestion cards are the only strings in this plugin a person reads,
 * and they are CONTENT rather than interface chrome — a card title, its
 * one-line gloss, and the prompt a click inserts. They still belong here:
 * a card that says「云资源查询」to an English reader is worse than no card,
 * and the prompt it inserts would start an English conversation in Chinese.
 *
 * Chinese is the key-set source of truth; English is complete against it and
 * is also the terminal fallback, so every locale other than `zh` reads
 * English. That is the framework's own chain (`LOCALE_IDS = ["zh", "en"]`,
 * with English carrying no fallback) — there is no third dictionary to write.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'aishell-brand' as const

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // Carousel controls. Screen-reader only, but a person reading the UI in
  // English should not hear Chinese from the arrows.
  'suggestion.previous': '上一个示例',
  'suggestion.next': '下一个示例',

  // Card 1 — cloud resource inventory.
  'suggestion.inventory.title': '云资源查询',
  'suggestion.inventory.gloss': '列出当前账号下的云资源',
  'suggestion.inventory.prompt':
    '请列出我的华为云资源清单，按服务分类（计算、存储、网络、数据库等），标出每类资源的数量和所在区域。',

  // Card 2 — deployment options.
  'suggestion.deploy.title': '部署方案推荐',
  'suggestion.deploy.gloss': '按访问量和预算给出可落地的部署路径',
  'suggestion.deploy.prompt':
    '我要部署一个轻量级 Web 应用，请对比几种可行的部署方案，说明各自的适用规模、月度成本量级和运维复杂度，并给出你的推荐及理由。',

  // Card 3 — enterprise cloud adoption.
  //
  // The only card whose prompt is a DESIGN brief rather than a question about
  // the account, and the concrete company is what keeps it from producing
  // architecture prose: a named size, a named industry and a named compliance
  // bar are constraints the model has to compute against. A brief without them
  // — "a landing zone, covering account structure, network partitions,
  // permission boundaries and audit requirements" — anchors nothing, so the
  // only possible answer is generic.
  //
  // MIGRATION rather than a greenfield design, because that is the situation
  // an enterprise is actually in, and it forces the answer to deal with what
  // already exists — which is also what `list_existing_resources` and
  // `terraform_import` are for.
  //
  // Two deliberate subtractions. No cost: that is the billing card's job, and
  // asking for it here would make two cards answer the same question. Audit is
  // a CONSTRAINT on the network design ("must meet Level 3") rather than a
  // deliverable — the tools build VPCs, subnets and security groups, and
  // nothing here can produce a compliance plan.
  //
  // No meta-instruction ("don't just give general principles"). Telling the
  // model how to answer is not a prompt; the constraints are the prompt.
  'suggestion.enterprise.title': '企业上云',
  'suggestion.enterprise.gloss': '多账号、网络分区与权限边界的整体设计',
  'suggestion.enterprise.prompt':
    '一家 200 人的电商公司要把业务迁到华为云，需要满足等保三级。现状是开发、测试、生产共用一套 VPC，没有做网络隔离。请设计改造方案：账号怎么划分，VPC 和子网如何切分，安全组规则怎么定，以及迁移的先后顺序和每一步的风险。',

  // Card 4 — billing analysis.
  'suggestion.billing.title': '账单分析',
  'suggestion.billing.gloss': '分析上个月的云资源支出',
  'suggestion.billing.prompt':
    '请分析我上个月的云资源支出构成，找出占比最高的几项服务，指出其中可以优化或降配的部分，并估算调整后能节省多少。',

  // Card 5 — security review.
  //
  // The gloss says "是否存在安全问题" without promising a live answer: the
  // inventory behind it is RMS, whose own tool description warns that recently
  // created or destroyed resources may not show up immediately. "实时" would
  // promise something the data source does not offer.
  'suggestion.security.title': '安全审查',
  'suggestion.security.gloss': '检查云资源是否存在安全问题',
  'suggestion.security.prompt':
    '请检查我的华为云资源是否存在安全问题，重点看安全组规则、端口暴露、存储权限和密钥管理，指出高危项并给出修复建议。',
} as const

/** English dictionary. Complete against {@link zh}; also the terminal fallback. */
export const en = {
  // Carousel controls.
  'suggestion.previous': 'Previous example',
  'suggestion.next': 'Next example',

  // Card 1 — cloud resource inventory. Kept to the same shape as the Chinese:
  // a short scannable title, a one-line gloss, and a prompt that carries the
  // context and the expected output so the first message needs no editing.
  'suggestion.inventory.title': 'Cloud inventory',
  'suggestion.inventory.gloss': 'List the resources in this account',
  'suggestion.inventory.prompt':
    'List the resources in my Huawei Cloud account, grouped by service '
    + '(compute, storage, network, database), with the count and the region for each group.',

  // Card 2 — deployment options.
  'suggestion.deploy.title': 'Deployment options',
  'suggestion.deploy.gloss': 'A workable path for your traffic and budget',
  'suggestion.deploy.prompt':
    'I want to deploy a lightweight web application. Compare a few viable deployment options, '
    + 'covering the scale each one suits, its order-of-magnitude monthly cost, and its '
    + 'operational complexity, then recommend one and explain why.',

  // Card 3 — enterprise cloud adoption. "Landing zone" is the term of art in
  // English, so the title uses it where the Chinese title stays plain. See the
  // Chinese dictionary for why this prompt carries a concrete company and why
  // it asks for a migration rather than a design.
  //
  // 等保三级 has no short English name — it is China's Multi-Level Protection
  // Scheme, and the gloss keeps the Chinese term beside the translation so an
  // English reader gets both the rule and what it is called locally.
  'suggestion.enterprise.title': 'Landing zone',
  'suggestion.enterprise.gloss': 'Multi-account structure, network and permission boundaries',
  'suggestion.enterprise.prompt':
    'A 200-person e-commerce company is migrating to Huawei Cloud and must meet Level 3 of '
    + "China's Multi-Level Protection Scheme (等保三级). Today development, test and production "
    + 'share a single VPC with no network isolation. Design the migration: how to split the '
    + 'accounts, how to divide the VPC and subnets, what the security group rules should be, '
    + 'and the order to migrate in with the risk at each step.',

  // Card 4 — billing analysis.
  'suggestion.billing.title': 'Billing analysis',
  'suggestion.billing.gloss': "Break down last month's cloud spend",
  'suggestion.billing.prompt':
    'Analyse my cloud spend for last month, identify the services that account for the '
    + 'largest share, point out what could be optimised or downsized, and estimate how much '
    + 'that would save.',

  // Card 5 — security review.
  'suggestion.security.title': 'Security review',
  'suggestion.security.gloss': 'Check the cloud resources for security problems',
  'suggestion.security.prompt':
    'Check my Huawei Cloud resources for security problems, looking in particular at '
    + 'security group rules, exposed ports, storage permissions and key management. '
    + 'Point out anything high-risk and suggest how to fix it.',
} as const

/** Every key, derived from the zh dictionary (the source of truth). */
export type AishellBrandLocaleKey = keyof typeof zh

// Merge the namespace into the framework's LocaleNamespaceMap so
// PropsLocale<NS> resolves to a typed `t` at compile time, and so a key
// missing from either dictionary is a compile error rather than a blank card.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'aishell-brand': AishellBrandLocaleKey
  }
}