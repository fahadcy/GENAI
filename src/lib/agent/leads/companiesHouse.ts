/**
 * Companies House public data API.
 * https://developer-specs.company-information.service.gov.uk/
 *
 * Rate limit is 600 requests per 5 minutes per key; we space calls at
 * 550 ms (≈545 per 5 min) and back off on 429. Read-only.
 */

export interface ChAddress { address_line_1?: string; locality?: string; region?: string; postal_code?: string; country?: string }
export interface ChProfile {
  company_number: string; company_name: string;
  company_status: string; company_status_detail?: string;
  type: string; date_of_creation?: string; date_of_cessation?: string;
  sic_codes?: string[];
  registered_office_address?: ChAddress;
  accounts?: { overdue?: boolean; next_due?: string; next_made_up_to?: string; last_accounts?: { type?: string; made_up_to?: string } };
  confirmation_statement?: { overdue?: boolean; next_due?: string; last_made_up_to?: string };
  has_charges?: boolean; has_insolvency_history?: boolean;
  jurisdiction?: string;
}
export interface ChOfficer { name: string; officer_role: string; appointed_on?: string; resigned_on?: string }
export interface ChSearchItem {
  company_number: string; company_name: string; company_status: string; company_type: string;
  date_of_creation?: string; sic_codes?: string[]; registered_office_address?: ChAddress;
}
export interface AdvancedSearch {
  sicCodes?: string[]; location?: string; incorporatedFrom?: string; incorporatedTo?: string;
  companyType?: string[]; size?: number; startIndex?: number;
}

export interface CompaniesHousePort {
  profile(number: string): Promise<ChProfile | null>;
  officers(number: string): Promise<ChOfficer[]>;
  advancedSearch(q: AdvancedSearch): Promise<{ items: ChSearchItem[]; hits: number }>;
}

export const CH_WEB = 'https://find-and-update.company-information.service.gov.uk/company/';

export class CompaniesHouseClient implements CompaniesHousePort {
  private last = 0;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private key: string, opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; spacingMs?: number; base?: string } = {}) {
    if (!key.trim()) throw new Error('Companies House API key is empty');
    this.f = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.spacing = opts.spacingMs ?? 550;
    this.base = opts.base ?? 'https://api.company-information.service.gov.uk';
  }
  private spacing: number;
  private base: string;

  private async get<T>(path: string): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.last + this.spacing - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      const r = await this.f(this.base + path, { headers: { Authorization: 'Basic ' + Buffer.from(this.key.trim() + ':').toString('base64') } });
      if (r.status === 404) return null;
      if (r.status === 429) { await this.sleep(5000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`Companies House ${r.status} for ${path.split('?')[0]}`);
      return (await r.json()) as T;
    }
    throw new Error('Companies House rate limit: gave up after 4 tries');
  }

  profile(number: string) { return this.get<ChProfile>(`/company/${encodeURIComponent(normCompanyNumber(number))}`); }
  async officers(number: string) {
    const r = await this.get<{ items?: ChOfficer[] }>(`/company/${encodeURIComponent(normCompanyNumber(number))}/officers?items_per_page=50`);
    return r?.items ?? [];
  }
  async advancedSearch(q: AdvancedSearch) {
    const p = new URLSearchParams({ company_status: 'active', size: String(Math.min(q.size ?? 100, 500)), start_index: String(q.startIndex ?? 0) });
    if (q.sicCodes?.length) p.set('sic_codes', q.sicCodes.join(','));
    if (q.location) p.set('location', q.location);
    if (q.incorporatedFrom) p.set('incorporated_from', q.incorporatedFrom);
    if (q.incorporatedTo) p.set('incorporated_to', q.incorporatedTo);
    if (q.companyType?.length) p.set('company_type', q.companyType.join(','));
    const r = await this.get<{ items?: ChSearchItem[]; hits?: number }>(`/advanced-search/companies?${p}`);
    return { items: r?.items ?? [], hits: r?.hits ?? 0 };
  }
}

export function normCompanyNumber(n: string): string {
  const s = n.replace(/\s+/g, '').toUpperCase();
  return /^\d{1,7}$/.test(s) ? s.padStart(8, '0') : s;
}
export function isCompanyNumber(n: string): boolean { return /^(\d{8}|[A-Z]{2}\d{6})$/.test(normCompanyNumber(n)); }

/** Corporate bodies: PECR treats these as corporate subscribers. Mirrors the CRM's list. */
export const CORPORATE_TYPES = new Set([
  'ltd', 'plc', 'llp', 'private-unlimited', 'private-unlimited-nsc', 'private-limited-guarant-nsc',
  'private-limited-guarant-nsc-limited-exemption', 'private-limited-shares-section-30-exemption', 'old-public-company',
]);

/** SIC division (first two digits) → section letter and plain name. */
const SECTIONS: [number, number, string, string][] = [
  [1, 3, 'A', 'Agriculture, forestry and fishing'], [5, 9, 'B', 'Mining and quarrying'], [10, 33, 'C', 'Manufacturing'],
  [35, 35, 'D', 'Energy supply'], [36, 39, 'E', 'Water and waste'], [41, 43, 'F', 'Construction'],
  [45, 47, 'G', 'Wholesale and retail'], [49, 53, 'H', 'Transport and storage'], [55, 56, 'I', 'Hospitality'],
  [58, 63, 'J', 'Information and communication'], [64, 66, 'K', 'Finance and insurance'], [68, 68, 'L', 'Real estate'],
  [69, 75, 'M', 'Professional services'], [77, 82, 'N', 'Admin and support services'], [84, 84, 'O', 'Public administration'],
  [85, 85, 'P', 'Education'], [86, 88, 'Q', 'Health and social care'], [90, 93, 'R', 'Arts and recreation'],
  [94, 96, 'S', 'Other services'], [97, 98, 'T', 'Households'], [99, 99, 'U', 'Extraterritorial'],
];
export function sicSection(sic: string): { letter: string; name: string } | null {
  const d = Number(String(sic).slice(0, 2));
  if (!Number.isFinite(d)) return null;
  for (const [lo, hi, letter, name] of SECTIONS) if (d >= lo && d <= hi) return { letter, name };
  return null;
}
export function sectionName(letter: string): string { return SECTIONS.find(s => s[2] === letter)?.[3] ?? letter; }
