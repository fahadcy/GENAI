/**
 * The Gazette: winding-up petitions (notice code 2450).
 *
 * A petition is public notice that a creditor has asked the court to wind
 * a company up; the hearing is usually a few weeks away. For an insolvency
 * practice it is the clearest possible sign of need, and the most sensitive:
 * the company's directors are under pressure, so the outreach rules
 * (R2360.8, no harassment) matter most here.
 *
 * Gazette data is Crown copyright under the Open Government Licence; notices
 * name individuals, so use is limited to the legitimate purpose recorded in
 * the business's legitimate interests assessment.
 *
 * The feed is Atom. Parsed without an XML library: entries are flat and we
 * read only id, title, link, published and the text of content.
 */

export interface GazetteNotice {
  noticeId: string;
  companyName: string;
  companyNumber: string | null;
  published: string;          // ISO
  url: string;
  hearingDate: string | null; // ISO date if the notice states one
}

export const GAZETTE_PETITIONS_FEED =
  'https://www.thegazette.co.uk/insolvency/notice/data.feed?noticetypes=2450&results-page-size=100';

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]!) : '';
};

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

export function parseGazetteFeed(xml: string): GazetteNotice[] {
  const out: GazetteNotice[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1]!;
    const id = tag(e, 'id');
    const link = e.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] ?? id;
    const content = tag(e, 'content') || tag(e, 'summary');
    const title = tag(e, 'title');
    const num = content.match(/Company\s*(?:Number|No\.?|Registration Number)\s*[:.]?\s*([A-Z]{2}\d{6}|\d{6,8})/i)?.[1]
             ?? title.match(/\(([A-Z]{2}\d{6}|\d{8})\)/)?.[1] ?? null;
    let hearing: string | null = null;
    const h = content.match(/(?:heard|hearing)[^.]{0,120}?(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (h) hearing = `${h[3]}-${String(MONTHS[h[2]!.toLowerCase()]).padStart(2, '0')}-${h[1]!.padStart(2, '0')}`;
    const noticeId = id.match(/notice\/(\w+)/)?.[1] ?? id;
    if (!title) continue;
    const link2 = link.startsWith('https://') ? link : `https://www.thegazette.co.uk/notice/${noticeId}`;
    out.push({
      noticeId, companyName: title.replace(/\s*\([^)]*\)\s*$/, '').trim(),
      companyNumber: num ? (num.length < 8 && /^\d+$/.test(num) ? num.padStart(8, '0') : num.toUpperCase()) : null,
      published: tag(e, 'published') || tag(e, 'updated'), url: link2, hearingDate: hearing,
    });
  }
  return out;
}

export async function fetchPetitions(f: typeof fetch = fetch, url = GAZETTE_PETITIONS_FEED): Promise<GazetteNotice[]> {
  const r = await f(url, { headers: { Accept: 'application/atom+xml' } });
  if (!r.ok) throw new Error(`Gazette ${r.status}`);
  return parseGazetteFeed(await r.text());
}
