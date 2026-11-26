/**
 * Website edits for the Easy Liquidation Next.js site, produced as file
 * changes for a pull request. Nothing here touches a live site.
 *
 * The site keeps its content in TypeScript:
 *   lib/blogData.ts         blog posts; `content` is HTML rendered with
 *                           dangerouslySetInnerHTML, so it is sanitised here
 *                           against a strict allowlist
 *   lib/keywordLandings.ts  SEO landing pages, each with a page.tsx route
 *   app/sitemap.ts          static routes (blog posts are added automatically)
 *
 * Edits are text insertions at the end of the arrays, so the diff a person
 * reviews is exactly the new entry.
 */
import { wordingProblems } from '../outreach/gate';

export interface FileChange { path: string; content: string; isNew: boolean }
export interface EditResult { changes: FileChange[]; problems: string[]; warnings: string[]; url: string }

// ── HTML sanitiser ─────────────────────────────────────────────────────
const ALLOWED = new Set(['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'blockquote', 'br', 'section', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const VOID = new Set(['br']);
const SITE_HOSTS = new Set(['easyliquidation.co.uk', 'www.easyliquidation.co.uk']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'textarea', 'select', 'title', 'head']);

const escText = (s: string) => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keep only allowlisted tags; links only to https:// or site-relative paths; every other attribute dropped. */
export function sanitizeHtml(html: string): string {
  // Remove dropped elements with their content, and comments.
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const t of DROP_WITH_CONTENT) s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?(?:</${t}\\s*>|$)`, 'gi'), '');
  const out: string[] = [];
  const open: string[] = [];
  // Attribute values may contain ">" inside quotes; match them as units.
  const re = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push(escText(s.slice(last, m.index)));
    last = re.lastIndex;
    const closing = m[1] === '/', tag = m[2]!.toLowerCase(), attrs = m[3] ?? '';
    if (!ALLOWED.has(tag)) continue;
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i === -1) continue;
      while (open.length > i) out.push(`</${open.pop()}>`);
      continue;
    }
    if (VOID.has(tag)) { out.push(`<${tag}>`); continue; }
    if (tag === 'a') {
      const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      // Decode entities and strip control chars before deciding, so "jav&#x61;script:" can't slip through.
      const decoded = raw.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d))).replace(/[\u0000- ]/g, '');
      // Browsers treat "\" like "/", so "/\evil.com" is off-site: refuse any backslash.
      let safe = false, ext = false;
      if (!decoded.includes('\\') && !/[\s"'<>]/.test(decoded)) {
        if (/^\/(?!\/)/.test(decoded)) safe = true;
        else if (/^https:\/\//i.test(decoded)) {
          try { const u = new URL(decoded); safe = u.protocol === 'https:' && !u.username && !u.password; ext = !SITE_HOSTS.has(u.hostname.toLowerCase()); } catch { safe = false; }
        }
      }
      if (!safe) { open.push('a-dropped'); continue; }
      out.push(`<a href="${escAttr(decoded)}"${ext ? ' rel="noopener nofollow" target="_blank"' : ''}>`);
      open.push('a');
      continue;
    }
    out.push(`<${tag}>`);
    open.push(tag);
  }
  out.push(escText(s.slice(last)));
  while (open.length) { const t = open.pop()!; if (t !== 'a-dropped') out.push(`</${t}>`); }
  return out.join('').replace(/<\/a-dropped>/g, '');
}

export const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// ── Shared checks ──────────────────────────────────────────────────────
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

function seoChecks(o: { title: string; description: string; keyword?: string; bodyText: string; firstPara: string; minWords?: number; goodWords?: number }, warnings: string[], problems: string[]) {
  if (o.title.length < 25 || o.title.length > 65) warnings.push(`Title is ${o.title.length} characters; 25–65 shows best in search results`);
  if (o.description.length < 70 || o.description.length > 160) warnings.push(`Description is ${o.description.length} characters; aim for 70–160`);
  const words = o.bodyText.split(/\s+/).filter(Boolean).length;
  const min = o.minWords ?? 300, good = o.goodWords ?? 600;
  if (words < min) problems.push(`Only ${words} words: too thin to publish`);
  else if (words < good) warnings.push(`${words} words; pages that rank usually run ${good}+`);
  if (o.keyword) {
    const k = o.keyword.toLowerCase();
    if (!o.title.toLowerCase().includes(k)) warnings.push(`Keyword "${o.keyword}" is not in the title`);
    if (!o.firstPara.toLowerCase().includes(k)) warnings.push(`Keyword "${o.keyword}" is not in the first paragraph`);
  }
  for (const p of wordingProblems(`${o.title}\n${o.description}\n${o.bodyText}`)) problems.push(`Wording ${p}`);
  if (/£\s?\d/.test(o.bodyText + o.description) && !/what('|’)?s included|covers|plus vat|inc(lusive|\.)? vat|fixed fee for/i.test(o.bodyText + o.description)) {
    warnings.push('Mentions a fee without saying what it covers (Insolvency Code of Ethics 2360.6 A1): add what is included');
  }
}

// TypeScript string literal (double-quoted) and template literal escaping
const tsString = (s: string) => JSON.stringify(s);
const tsTemplate = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/** Index of the `]` that closes the array opened by `marker`. Understands strings, template literals with ${…}, and comments. */
export function arrayEnd(src: string, marker: string): number {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${marker}`);
  let i = src.indexOf('=', start);
  i = src.indexOf('[', i === -1 ? start : i);
  if (i === -1) throw new Error(`No array after ${marker}`);
  const stack: string[] = [];
  let q: '"' | "'" | null = null;
  for (; i < src.length; i++) {
    const c = src[i]!, top = stack[stack.length - 1];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') { stack.push('${'); i++; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '`') { stack.push('`'); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n === -1) break; i = n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n === -1) break; i = n + 1; continue; }
    if (c === '[' || c === '{') stack.push(c);
    else if (c === ']' || c === '}') {
      stack.pop();
      if (stack.length === 0) { if (c === ']') return i; throw new Error(`Unbalanced braces after ${marker}`); }
    }
  }
  throw new Error(`Unclosed array after ${marker}`);
}

function insertBeforeArrayEnd(src: string, marker: string, entry: string): string {
  const end = arrayEnd(src, marker);
  let before = src.slice(0, end).replace(/\s*$/, '');
  if (!before.endsWith(',') && !before.endsWith('[')) before += ',';
  return `${before}\n${entry}\n${src.slice(end)}`;
}

// ── Blog post ──────────────────────────────────────────────────────────
export interface BlogDraft { title: string; excerpt: string; html: string; slug?: string; keyword?: string; imageUrl?: string }

export function addBlogPost(blogDataSrc: string, d: BlogDraft, existingImages: string[], siteUrl = 'https://easyliquidation.co.uk'): EditResult {
  const problems: string[] = [], warnings: string[] = [];
  const slug = slugify(d.slug || d.title);
  if (!slug) problems.push('Title gives an empty slug');
  const slugs = [...blogDataSrc.matchAll(/\bslug:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
  if (slugs.includes(slug)) problems.push(`A post with slug "${slug}" already exists`);
  const ids = [...blogDataSrc.matchAll(/\bid:\s*(\d+)/g)].map(m => Number(m[1]));
  const id = (ids.length ? Math.max(...ids) : 0) + 1;
  const html = sanitizeHtml(d.html);
  if (html.replace(/\s+/g, '') !== d.html.replace(/\s+/g, '')) warnings.push('Some HTML was removed by the sanitiser (scripts, styles, images, unsafe links or unknown tags)');
  const body = textOf(html);
  if ((html.match(/<h[23]>/g) ?? []).length < 2) warnings.push('Fewer than two section headings');
  if (/<h1>/i.test(d.html)) warnings.push('h1 removed: the page template already sets the title');
  const firstPara = textOf(html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
  seoChecks({ title: d.title, description: d.excerpt, keyword: d.keyword, bodyText: body, firstPara }, warnings, problems);
  let image = d.imageUrl ?? '';
  if (!image || !existingImages.includes(image)) {
    if (image) warnings.push(`Image ${image} is not in public/: using an existing one`);
    image = existingImages.find(f => /liquidat|company|director/i.test(f)) ?? existingImages[0] ?? '';
  }
  const entry = `  {
    id: ${id},
    slug: ${tsString(slug)},
    title: ${tsString(d.title.trim())},
    excerpt: ${tsString(d.excerpt.trim())},
    imageUrl: ${tsString(image)},
    content: \`
${tsTemplate(html)}
    \`,
  },`;
  const content = insertBeforeArrayEnd(blogDataSrc, 'export const blogPosts', entry);
  return { changes: [{ path: 'lib/blogData.ts', content, isNew: false }], problems, warnings, url: `${siteUrl}/blog/${slug}` };
}

// ── Keyword landing page ───────────────────────────────────────────────
export interface LandingDraft {
  keyword: string; title: string; description: string; h1: string; intro: string;
  points: string[]; paragraphs: string[]; faqs: { question: string; answer: string }[]; slug?: string;
}

const pascal = (slug: string) => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/^(\d)/, 'P$1');

export function addKeywordLanding(files: { landings: string; sitemap: string; existingRoutes: string[] }, d: LandingDraft, siteUrl = 'https://easyliquidation.co.uk'): EditResult {
  const problems: string[] = [], warnings: string[] = [];
  const slug = slugify(d.slug || d.keyword);
  if (!slug) problems.push('Empty slug');
  if (files.existingRoutes.includes(slug) || new RegExp(`slug:\\s*["']${slug}["']`).test(files.landings)) problems.push(`/${slug} already exists`);
  if (d.points.length < 2 || d.points.length > 6) warnings.push('Use 2–6 key points');
  if (d.faqs.length < 3) warnings.push('Fewer than 3 FAQs: FAQ rich results need a few');
  const plain = [d.title, d.description, d.h1, d.intro, ...d.points, ...d.paragraphs, ...d.faqs.flatMap(f => [f.question, f.answer])];
  if (plain.some(t => /<[a-z!/]/i.test(t))) problems.push('Landing text is plain text: remove HTML');
  seoChecks({ title: d.title, description: d.description, keyword: d.keyword, bodyText: plain.join(' '), firstPara: d.intro, minWords: 150, goodWords: 300 }, warnings, problems);
  if (!d.h1.toLowerCase().includes(d.keyword.toLowerCase())) warnings.push(`Keyword "${d.keyword}" is not in the h1`);
  const arr = (xs: string[], ind: string) => `[\n${xs.map(x => `${ind}  ${tsString(x.trim())},`).join('\n')}\n${ind}]`;
  const entry = `  {
    slug: ${tsString(slug)},
    keyword: ${tsString(d.keyword.trim())},
    title: ${tsString(d.title.trim())},
    description:
      ${tsString(d.description.trim())},
    h1: ${tsString(d.h1.trim())},
    intro:
      ${tsString(d.intro.trim())},
    points: ${arr(d.points, '    ')},
    paragraphs: ${arr(d.paragraphs, '    ')},
    faqs: [
${d.faqs.map(f => `      {\n        question: ${tsString(f.question.trim())},\n        answer:\n          ${tsString(f.answer.trim())},\n      },`).join('\n')}
    ],
  },`;
  const landings = insertBeforeArrayEnd(files.landings, 'export const keywordLandings', entry);
  const page = `import type { Metadata } from "next";
import KeywordLandingView from "@/components/KeywordLandingView";
import TawkWidget from "@/components/TawkWidget";
import { getKeywordLanding } from "@/lib/keywordLandings";

const page = getKeywordLanding(${tsString(slug)})!;

export const metadata: Metadata = {
  title: page.title,
  description: page.description,
};

export default function ${pascal(slug)}Page() {
  return (
    <>
      <TawkWidget />
      <KeywordLandingView page={page} />
    </>
  );
}
`;
  const sitemap = insertBeforeArrayEnd(files.sitemap, 'const staticRoutes', `    ${tsString('/' + slug)},`);
  return {
    changes: [
      { path: 'lib/keywordLandings.ts', content: landings, isNew: false },
      { path: `app/${slug}/page.tsx`, content: page, isNew: true },
      { path: 'app/sitemap.ts', content: sitemap, isNew: false },
    ],
    problems, warnings, url: `${siteUrl}/${slug}`,
  };
}
