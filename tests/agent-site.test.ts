import { describe, it, expect } from './expect';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sanitizeHtml, addBlogPost, addKeywordLanding, slugify, arrayEnd } from '../src/lib/agent/site/edits';
import { GitHubSite } from '../src/lib/agent/site/github';

const fx = (f: string) => readFileSync(new URL(`./fixtures/agent/${f}`, import.meta.url), 'utf8');
const images = fx('public-images.txt').trim().split('\n');
const routes = fx('app-routes.txt').trim().split('\n');

/** Transpile a TS module and evaluate it, to prove the edited file is still valid and holds what we think. */
function evalModule(src: string, stubs: Record<string, unknown> = {}): any {
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  expect(out.diagnostics ?? []).toEqual([]);
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', out.outputText)(module, module.exports, (m: string) => stubs[m] ?? {});
  return module.exports;
}

const ARTICLE = `<h2>What a winding-up petition means</h2><p>A winding-up petition is a court application by a creditor. This guide explains what directors can do.</p>
${'<p>Directors often have more options than they think, and taking advice early keeps those options open. A licensed insolvency practitioner can explain each route in plain English, including what it means for you personally. ' + 'Speaking to someone early is the single most useful step. '.repeat(6) + '</p>'.repeat(1)}
<h3>Your options</h3><ul><li>Pay the debt</li><li>Negotiate with the creditor</li><li>Place the company into liquidation</li></ul>
${'<p>Every situation is different, so the right route depends on the company, its creditors and its assets. We explain the steps, the timescales and what happens next. </p>'.repeat(14)}`;

describe('sanitizer', () => {
  it.each([
    ['<script>alert(1)</script><p>x</p>', '<p>x</p>'],
    ['<p onclick="steal()">hi</p>', '<p>hi</p>'],
    ['<a href="javascript:alert(1)">x</a>', 'x'],
    ['<a href="jav&#x61;script:alert(1)">x</a>', 'x'],
    ['<a href=" java\tscript:alert(1)">x</a>', 'x'],
    ['<a href="//evil.com">x</a>', 'x'],
    ['<a href="data:text/html,<b>">x</a>', 'x'],
    ['<img src=x onerror=alert(1)><p>ok</p>', '<p>ok</p>'],
    ['<iframe src="https://x"></iframe><p>ok</p>', '<p>ok</p>'],
    ['<style>body{display:none}</style><p>ok</p>', '<p>ok</p>'],
    ['<p>unclosed <strong>bold', '<p>unclosed <strong>bold</strong></p>'],
    ['<p>a</p></div></p>', '<p>a</p>'],
    ['<p>1 < 2 & 3 > 2</p>', '<p>1 &lt; 2 &amp; 3 &gt; 2</p>'],
    ['<!-- secret --><p>ok</p>', '<p>ok</p>'],
    ['<svg><script>alert(1)</script></svg><p>ok</p>', '<p>ok</p>'],
    ['<P CLASS="x">Up</P>', '<p>Up</p>'],
    ['<a href="/\\evil.com/login">x</a>', 'x'],
    ['<a href="&#x2F;&#x5C;evil.com">x</a>', 'x'],
    ['<a href="https://user:pw@easyliquidation.co.uk/">x</a>', 'x'],
  ])('%s', (input, expected) => { expect(sanitizeHtml(input)).toBe(expected); });
  it('keeps safe links; external ones get rel and target', () => {
    expect(sanitizeHtml('<a href="/contact">Contact</a>')).toBe('<a href="/contact">Contact</a>');
    expect(sanitizeHtml('<a href="https://www.gov.uk/x" class="c">gov</a>')).toBe('<a href="https://www.gov.uk/x" rel="noopener nofollow" target="_blank">gov</a>');
    expect(sanitizeHtml('<a href="https://easyliquidation.co.uk/faq">faq</a>')).toBe('<a href="https://easyliquidation.co.uk/faq">faq</a>');
    expect(sanitizeHtml('<a href="https://easyliquidation.co.uk.evil.com/">x</a>')).toContain('rel="noopener nofollow"');
  });
});

describe('blog post edit on the real lib/blogData.ts', () => {
  it('appends a valid entry with the next id and sanitised content', () => {
    const src = fx('blogData.ts.txt');
    const before = evalModule(src).blogPosts;
    const r = addBlogPost(src, { title: 'What Happens After a Winding-Up Petition?', excerpt: 'A plain-English guide for directors who have received a winding-up petition: what it means, the options and the timescales.',
      html: ARTICLE + '<script>alert(1)</script><p>Back tick ` and ${template} survive.</p>', keyword: 'winding-up petition' }, images);
    expect(r.problems).toEqual([]);
    expect(r.warnings.join()).toMatch(/sanitiser/);
    const after = evalModule(r.changes[0]!.content).blogPosts;
    expect(after).toHaveLength(before.length + 1);
    const post = after[after.length - 1];
    expect(post.id).toBe(Math.max(...before.map((p: any) => p.id)) + 1);
    expect(post.slug).toBe('what-happens-after-a-winding-up-petition');
    expect(post.content).not.toContain('<script');
    expect(post.content).toContain('Back tick ` and ${template} survive.');
    expect(images).toContain(post.imageUrl);
    expect(r.url).toBe('https://easyliquidation.co.uk/blog/what-happens-after-a-winding-up-petition');
    // Diff is append-only: the original text is a prefix (minus trailing whitespace) of the new file.
    expect(r.changes[0]!.content.startsWith(src.slice(0, arrayEnd(src, 'export const blogPosts')).replace(/\s*$/, ''))).toBe(true);
  });
  it('refuses duplicates, thin content and banned claims', () => {
    const src = fx('blogData.ts.txt');
    const dup = addBlogPost(src, { title: 'Can Directors Buy Back Assets From a Liquidator?', excerpt: 'x'.repeat(100), html: ARTICLE }, images);
    expect(dup.problems.join()).toMatch(/already exists/);
    const thin = addBlogPost(src, { title: 'A short note on liquidation for directors', excerpt: 'x'.repeat(100), html: '<p>Too short.</p>' }, images);
    expect(thin.problems.join()).toMatch(/too thin/);
    const bad = addBlogPost(src, { title: 'Write off your debts with a guaranteed liquidation', excerpt: 'x'.repeat(100), html: ARTICLE }, images);
    expect(bad.problems.join()).toMatch(/write off/i);
  });
});

describe('landing page edit on the real files', () => {
  const draft = {
    keyword: 'winding up petition help', title: 'Winding Up Petition Help for Company Directors', description: 'Received a winding up petition? Speak to a licensed insolvency practitioner about your options before the hearing. Confidential advice.',
    h1: 'Winding Up Petition Help from a Licensed Practitioner', intro: 'If your company has received a winding up petition, you still have options before the hearing. We explain them in plain English.',
    points: ['Licensed insolvency practitioner, regulated by the IPA', 'Confidential first conversation', 'Clear explanation of every option'],
    paragraphs: ['A winding up petition is a creditor asking the court to close the company. Between the petition and the hearing, directors can still act, and the earlier they take advice the more options remain open.', 'We explain whether paying, negotiating, a CVA or a voluntary liquidation is right, and what each means for you personally as a director.'],
    faqs: [{ question: 'How long until the hearing?', answer: 'Usually several weeks after the petition is presented; the notice in The Gazette gives the date.' },
           { question: 'Can I still sell company assets?', answer: 'Dispositions after a petition can be void without court approval, so take advice before selling anything.' },
           { question: 'Will my bank account be frozen?', answer: 'Banks often freeze accounts once a petition is advertised, which is why early advice matters.' }],
  };
  it('adds entry, page and sitemap route; all still valid TypeScript', () => {
    const r = addKeywordLanding({ landings: fx('keywordLandings.ts.txt'), sitemap: fx('sitemap.ts.txt'), existingRoutes: routes }, draft);
    expect(r.problems).toEqual([]);
    const paths = r.changes.map(c => c.path);
    expect(paths).toEqual(['lib/keywordLandings.ts', 'app/winding-up-petition-help/page.tsx', 'app/sitemap.ts']);
    const lp = evalModule(r.changes[0]!.content);
    const added = lp.keywordLandings[lp.keywordLandings.length - 1];
    expect(added.slug).toBe('winding-up-petition-help');
    expect(lp.getKeywordLanding?.('winding-up-petition-help')?.h1 ?? added.h1).toBe(draft.h1);
    expect(r.changes[2]!.content).toContain('"/winding-up-petition-help",');
    const page = ts.transpileModule(r.changes[1]!.content, { compilerOptions: { jsx: ts.JsxEmit.Preserve }, reportDiagnostics: true, fileName: 'page.tsx' });
    expect(page.diagnostics).toEqual([]);
    expect(r.changes[1]!.content).toContain('export default function WindingUpPetitionHelpPage()');
  });
  it('refuses a route that already exists', () => {
    const r = addKeywordLanding({ landings: fx('keywordLandings.ts.txt'), sitemap: fx('sitemap.ts.txt'), existingRoutes: routes }, { ...draft, keyword: 'company liquidation' });
    expect(r.problems.join()).toMatch(/already exists/);
  });
  it('slugify', () => { expect(slugify("Directors' Guide: CVL vs MVL — 2026!")).toBe('directors-guide-cvl-vs-mvl-2026'); });
});

describe('GitHub pull requests', () => {
  function fakeGh() {
    const calls: { method: string; path: string; body: any }[] = [];
    const f = (async (url: string, init: any) => {
      const path = url.replace('https://api.github.com/repos/cy/site', '');
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init?.method ?? 'GET', path, body });
      const json = (s: number, d: unknown) => new Response(JSON.stringify(d), { status: s });
      if (path === '') return json(200, { default_branch: 'main' });
      if (path.startsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'base123' } });
      if (path === '/git/commits/base123') return json(200, { tree: { sha: 'tree0' } });
      if (path === '/git/trees') return json(201, { sha: 'tree1' });
      if (path === '/git/commits') return json(201, { sha: 'commit1' });
      if (path === '/git/refs') return body.ref.endsWith('/taken') ? json(422, {}) : json(201, {});
      if (path === '/pulls') return json(201, { number: 42, html_url: 'https://github.com/cy/site/pull/42', draft: body.draft });
      return json(404, {});
    }) as unknown as typeof fetch;
    return { calls, gh: new GitHubSite({ owner: 'cy', repo: 'site', token: 't', fetch: f }) };
  }
  it('one atomic commit on an genai/ branch, then a DRAFT PR', async () => {
    const { calls, gh } = fakeGh();
    const pr = await gh.openPullRequest({ branch: 'genai/blog-x', title: 'Blog: x', body: 'b', message: 'm', files: [{ path: 'lib/blogData.ts', content: 'c' }] });
    expect(pr).toEqual({ number: 42, url: 'https://github.com/cy/site/pull/42', branch: 'genai/blog-x', draft: true });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET ', 'GET /git/ref/heads/main', 'GET /git/commits/base123', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
    expect(calls.find(c => c.path === '/git/commits')!.body.parents).toEqual(['base123']);
    expect(calls.some(c => c.path.includes('/heads/main') && c.method !== 'GET')).toBe(false);   // never writes main
  });
  it('refuses to commit if the site moved after the files were read', async () => {
    const { gh } = fakeGh();
    await expect(gh.openPullRequest({ branch: 'genai/x1x', title: '', body: '', message: '', files: [{ path: 'a.ts', content: '' }], expectedBaseSha: 'older999' })).rejects.toThrow(/changed while/);
    expect(await gh.headSha()).toBe('base123');
  });
  it('refuses unsafe branches and paths, and reports a taken branch', async () => {
    const { gh } = fakeGh();
    await expect(gh.openPullRequest({ branch: 'main', title: '', body: '', message: '', files: [{ path: 'a', content: '' }] })).rejects.toThrow(/genai\//);
    await expect(gh.openPullRequest({ branch: 'genai/x1x', title: '', body: '', message: '', files: [{ path: '.github/workflows/x.yml', content: '' }] })).rejects.toThrow(/Refusing/);
    await expect(gh.openPullRequest({ branch: 'genai/x1x', title: '', body: '', message: '', files: [{ path: '../etc', content: '' }] })).rejects.toThrow(/Refusing/);
    await expect(gh.openPullRequest({ branch: 'genai/taken', title: '', body: '', message: '', files: [{ path: 'a.ts', content: '' }] })).rejects.toThrow(/already exists/);
  });
});
