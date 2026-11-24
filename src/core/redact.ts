/**
 * Masks what looks like a secret before text is sent to a model or kept on disk: keys and tokens
 * of common services (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xoxb-…`), JSON Web Tokens,
 * private key blocks, `Bearer` credentials, passwords in URLs, and `password=…`, `"token": "…"`,
 * `API_KEY: …` style assignments. What is left says what kind of secret was there. Pure: text in,
 * text out; masking twice changes nothing more.
 *
 * Every rule can start at many places of a long run of letters, digits, dots and hyphens, so what
 * a rule scans from one start is bounded: a scheme of at most 32 characters, a name of at most 64
 * before the word that makes it a secret, a digit within the first 128 characters of an `sk-` key,
 * a JSON Web Token header of at most 512. The time stays linear in the length of the text.
 */

/** What a secret becomes. */
export const MASK = "***";

type Replace = (match: string, ...groups: Array<string | undefined>) => string;

/** Names that hold secrets: password, DB_PASSWD, client_secret, SECRET_KEY, GITHUB_TOKEN, apiKey, … */
const KEY = String.raw`[A-Za-z0-9_.-]{0,64}?(?:passw(?:or)?d|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?`;

/** Values that name a type, count something or point elsewhere: `token: string`, `max_tokens=4096`, `password=$PASS`. */
const NOT_A_SECRET =
  /^(?:\d{1,6}|true|false|null|none|nil|undefined|string|number|boolean|bool|str|int|bytes|any|object|optional|required|[$%].*|process\.env\b.*|(?:os\.)?(?:environ|getenv)\b.*)$/iu;

const assigned: Replace = (match, keyQuote = "", key = "", separator = "", valueQuote = "", value = "") =>
  NOT_A_SECRET.test(value) || value.includes(MASK) ? match : `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${MASK}${valueQuote}`;

const RULES: ReadonlyArray<readonly [RegExp, Replace]> = [
  // PEM private keys, also when the text was cut off before their last line.
  [/-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/gu, () => "[private key]"],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]+:)[^\s/?#@]+@/giu, (_match, head = "") => `${head}${MASK}@`],
  // Anthropic, OpenAI and similar keys; a real one has a digit early on.
  [/\bsk-(?=[A-Za-z0-9_-]{0,128}\d)[A-Za-z0-9_-]{16,}/gu, () => `sk-${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/gu, () => `github_pat_${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/gu, (_match, prefix = "") => `${prefix}${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/gu, (_match, prefix = "") => `${prefix}${MASK}`],
  [/\b(xox[a-z])-[A-Za-z0-9-]{10,}/gu, (_match, prefix = "") => `${prefix}-${MASK}`],
  // JSON Web Tokens: base64 of `{"…` twice, then the signature.
  [/\beyJ[A-Za-z0-9_-]{5,512}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/gu, () => `eyJ${MASK}`],
  // A credential after Bearer has a digit; "Bearer authentication" in prose stays.
  [/\b(Bearer)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/giu, (_match, word = "") => `${word} ${MASK}`],
  // password="two words", "token": "…"
  [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)(["'])([^"'\n]{3,}?)\4`, "giu"), assigned],
  // PASSWORD=hunter2, api_key: abc123 (the empty group keeps the value where the quoted rule has it)
  [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)()(?!["'])([^\s"'\x60,;&<>()[\]{}]{3,})`, "giu"), assigned],
  [/(密码|口令|密钥|令牌|验证码)(\s*[:：=]\s*)([^\s，。；,;]{3,})/gu, (match, key = "", separator = "", value = "") => (value.includes(MASK) ? match : `${key}${separator}${MASK}`)],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace as (substring: string, ...args: unknown[]) => string);
  return out;
}
