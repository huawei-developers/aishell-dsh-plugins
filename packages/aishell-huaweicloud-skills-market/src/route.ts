/**
 * Everything both halves must agree on, and nothing either may import the
 * other for.
 *
 * Its own module because the Host half pulls in `node:fs`, `node:child_process`
 * and a git implementation; a Page importing any value from there would drag
 * Node built-ins into the browser bundle, where the loader's frozen module table
 * cannot resolve them. Only constants, types, and pure functions belong here.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/route
 */

/**
 * Absolute registration path on the Host.
 *
 * One route for every operation, discriminated by a body field, because the
 * Host's fetch registry is a `path → route` map: registering the same path twice
 * throws, and there is no DELETE method to spend on a second verb. Everything
 * here is one resource — the skill catalogue and the installs made from it — so
 * one handler keeps a request and its answer together.
 */
export const SKILLS_MARKET_ROUTE = '/api/aishell/huaweicloud-skills-market'

/**
 * Document-relative form the Page addresses.
 *
 * Written without the leading slash because the served index carries
 * `<base href="./">`: the request must land on the origin that served the page,
 * which is what carries the browser session cookie the route's authentication
 * fence requires.
 */
export const SKILLS_MARKET_CLIENT_ROUTE = 'api/aishell/huaweicloud-skills-market'

/**
 * One skill, as the Page renders it.
 *
 * Deliberately flat and small: this crosses the process boundary once per skill
 * per catalogue read, and the Page renders a list of them. The bundle's files
 * stay on the Host — the Page never needs them, because installing is a Host
 * operation named by skill.
 */
export interface MarketSkill {
  /** Kebab-case name; also the directory name an install occupies. */
  readonly name: string
  /** One-line routing description from the skill's own frontmatter, already shortened. */
  readonly description: string
  /** The catalogue's category segment, such as `storage`. */
  readonly category: string
  /** The catalogue's product segment, such as `obs`. */
  readonly product: string
  /** Path of the bundle inside the upstream repository, for the detail page's source link. */
  readonly path: string
  /**
   * The skill's own frontmatter `tags`, unedited.
   *
   * Carried whole rather than pre-filtered here: which of them belong on a card
   * is a presentation decision (the card has room for a handful), while the
   * detail page shows the list as authored. Most skills declare tags, and every
   * list opens with the vendor name.
   */
  readonly tags: readonly string[]
  /** Whether this plugin installed it. A hand-authored skill of the same name is not "installed" here. */
  readonly installed: boolean
}

/** One catalogue read, plus what the Page needs to explain its own state. */
export interface MarketCatalog {
  /** Whether the upstream tree could be read. */
  readonly complete: boolean
  /** Why the read failed, when it did; absent on success. */
  readonly error?: string
  /** Skills, sorted by name. */
  readonly skills: readonly MarketSkill[]
}

/** The body the Page sends. */
export type MarketRequest =
  /**
   * Read the catalogue.
   *
   * `refresh` distinguishes the two reasons the Page asks: opening the tab wants
   * the catalogue now (any recent read will do), while the refresh control wants
   * the newest one (the person has asked upstream in so many words). Without it
   * the Host's cache would make the button a no-op.
   */
  | { readonly op: 'catalog', readonly refresh?: boolean }
  | { readonly op: 'install', readonly name: string }
  | { readonly op: 'uninstall', readonly name: string }
  | { readonly op: 'detail', readonly name: string }

/** One skill's detail page content. */
export interface MarketDetail {
  /** The skill's own `SKILL.md` body, with its frontmatter removed. */
  readonly body: string
  /** Absolute upstream URL for the bundle directory. */
  readonly sourceUrl: string
}

/** The answer to one request. */
export type MarketResponse =
  | { readonly ok: true, readonly op: 'catalog', readonly value: MarketCatalog }
  | { readonly ok: true, readonly op: 'detail', readonly value: MarketDetail }
  | { readonly ok: true, readonly op: 'install', readonly value: MarketCatalog }
  | { readonly ok: true, readonly op: 'uninstall', readonly value: MarketCatalog }
  | { readonly ok: false, readonly code: MarketCode, readonly message: string }

/** Stable failure names, so the Page can word them itself rather than parsing a message. */
export type MarketCode =
  /** The upstream tree could not be read at all. */
  | 'catalog-unavailable'
  /** The named skill is not in the current catalogue. */
  | 'unknown-skill'
  /** A directory of that name exists and this plugin did not create it. */
  | 'name-taken'
  /** The directory exists but does not carry this plugin's install marker. */
  | 'not-installed-here'
  /** The Host could not write or remove the bundle. */
  | 'write-failed'
  /** The request body was not a request this route understands. */
  | 'bad-request'

/**
 * The skill-name grammar, mirrored from the registry.
 *
 * Mirrored rather than imported: `isSkillName` lives in a Host-only package, and
 * the Page must reject a name before sending it. The two are one regex, quoted
 * from the registry's own source. If the upstream grammar ever widens, a name
 * this rejects is refused at the registry instead — a loud failure rather than a
 * silent one.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a name is a legal skill name.
 *
 * Load-bearing at the install boundary: the name becomes a directory under the
 * skills root, so a value carrying `..` or a separator would place a bundle
 * outside it. The grammar admits only lowercase letters, digits, and single
 * hyphens, so it cannot.
 *
 * @param name - candidate name.
 * @returns whether the registry would accept it.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}