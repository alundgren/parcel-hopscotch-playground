const sensitiveKey = /^(authorization|proxyauthorization|cookie|setcookie|apikey|openrouterapikey|token|accesstoken|refreshtoken|secret|password|cfaccessauthenticateduseremail|email)$/;
const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const openRouterKey = /\bsk-or-v1-[A-Za-z0-9_-]+\b/gi;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const redactString = (value: string): string =>
  value
    .replace(bearer, "[redacted]")
    .replace(openRouterKey, "[redacted]")
    .replace(email, "[redacted-email]");

export const redactProviderString = (value: string, maximum = 256): string =>
  redactString(value).slice(0, maximum);

export const redactProviderAudit = (value: unknown, depth = 0): unknown => {
  if (depth > 12) return "[depth-limit]";
  if (typeof value === "string") return redactProviderString(value, 16 * 1024);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderAudit(item, depth + 1));
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sensitiveKey.test(normalizeKey(key))
      ? "[redacted]"
      : redactProviderAudit(item, depth + 1);
  }
  return output;
};
