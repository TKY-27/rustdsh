import { object, text, digest } from "./contracts.mjs";

const kinds = ["repository", "tool_result", "web", "agent"];
const schema = "rdsh.external-source.v2";
const credentialField = /(?:^|[?:&;\s])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|passwd|credential|secret|token)\s*[:=]/i;
const bearerValue = /\bbearer\s+[a-z0-9._~+\/-]+=*/i;

function safeReference(kind, value) {
  const reference = text(value, "source reference", 2000);
  if (/[?#]/.test(reference) || /%(?:3f|23)/i.test(reference) ||
      credentialField.test(reference) || bearerValue.test(reference) ||
      /\b(?:gh[pousr]_[a-z0-9_]{10,}|github_pat_[a-z0-9_]{10,}|xox[baprs]-[a-z0-9-]{10,}|sk-[a-z0-9]{16,})\b/i.test(reference))
    throw new Error("Source reference must omit credentials, queries and fragments");

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(reference)?.[1].toLowerCase();
  const urlScheme = ["http", "https", "file"].includes(scheme);
  const explicitUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(reference);
  if (!urlScheme && !explicitUrl) return reference;
  let url;
  try { url = new URL(reference); } catch {
    throw new Error("Source URL reference is invalid");
  }
  if (url.username || url.password || url.search || url.hash ||
      !["http:", "https:", "file:"].includes(url.protocol) ||
      (kind !== "web" && ["http:", "https:"].includes(url.protocol)) ||
      (kind !== "repository" && url.protocol === "file:"))
    throw new Error("Source reference must omit credentials, queries and fragments");
  if (!/^(?:https?|file):\/\//i.test(reference))
    throw new Error("Source URL reference is invalid");
  return url.href;
}

function body(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536)
    throw new Error("External text must be at most 64 KiB");
  return value;
}
function seal(value) {
  Object.freeze(value.origin);
  for (const item of value.lineage) Object.freeze(item);
  Object.freeze(value.lineage);
  return Object.freeze(value);
}

// Attribution is metadata, never proof of identity or a grant. There is no
// constructor for trusted instructions or human approvals in this module.
export function externalSource(kind, reference, content) {
  if (!kinds.includes(kind)) throw new Error("Unknown external source kind");
  reference = safeReference(kind, reference);
  const content_digest = digest(body(content));
  return seal({ schema, authority: "untrusted_data",
    origin: { kind, reference, content_digest }, content, content_digest,
    lineage: [{ action: "capture", parent_digest: null, content_digest }] });
}
export function validateExternalSource(value) {
  object(value, ["schema", "authority", "origin", "content", "content_digest", "lineage"]);
  if (value.schema !== schema) throw new Error("Unsupported external source schema");
  if (value.authority !== "untrusted_data")
    throw new Error("External source cannot carry instruction authority");
  object(value.origin, ["kind", "reference", "content_digest"]);
  if (!kinds.includes(value.origin.kind)) throw new Error("Unknown external source kind");
  const reference = safeReference(value.origin.kind, value.origin.reference);
  if (reference !== value.origin.reference) throw new Error("Source reference is not canonical");
  const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!hash(value.origin.content_digest) || value.content_digest !== digest(body(value.content)) ||
      !Array.isArray(value.lineage) || !value.lineage.length || value.lineage.length > 32)
    throw new Error("Invalid external source lineage");
  for (const [index, item] of value.lineage.entries()) {
    object(item, ["action", "parent_digest", "content_digest"]);
    if (!hash(item.content_digest) || (index === 0 ? item.action !== "capture" || item.parent_digest !== null :
        !["summary", "forward"].includes(item.action))) throw new Error("Invalid external source lineage");
    if (index > 0 && (item.parent_digest !== value.lineage[index - 1].content_digest ||
        !hash(item.parent_digest))) throw new Error("External source lineage is not linked");
  }
  if (value.lineage[0].content_digest !== value.origin.content_digest ||
      value.lineage.at(-1).content_digest !== value.content_digest)
    throw new Error("External source lineage changed");
  return seal(structuredClone(value));
}
export function deriveExternalSource(source, action, content) {
  const original = validateExternalSource(source);
  if (!["summary", "forward"].includes(action) || original.lineage.length >= 32)
    throw new Error("Unsupported external source transformation");
  const content_digest = digest(body(content));
  return seal({ ...original, origin: { ...original.origin }, content, content_digest,
    lineage: [...original.lineage, { action,
      parent_digest: original.content_digest, content_digest }] });
}
export function sourceMetadata(source) {
  const value = validateExternalSource(source);
  return { schema: value.schema, authority: value.authority, origin: { ...value.origin },
    content_digest: value.content_digest, lineage: value.lineage.map((item) => ({ ...item })) };
}
export function renderExternalQuote(document, source) {
  const value = validateExternalSource(source);
  const figure = document.createElement("figure"), quote = document.createElement("pre"),
    caption = document.createElement("figcaption");
  quote.textContent = value.content;
  caption.textContent = `${value.origin.kind}: ${value.origin.reference} (untrusted_data)`;
  figure.append(quote, caption);
  return figure;
}
