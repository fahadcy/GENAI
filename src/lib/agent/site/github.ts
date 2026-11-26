/**
 * Website changes as GitHub pull requests.
 *
 * The agent never pushes to the default branch. It makes one atomic commit
 * on a new genai/… branch (Git Data API: tree → commit → ref) and opens a
 * DRAFT pull request. A person reviews the diff and the Vercel preview,
 * merges, and the site deploys; reverting is reverting the PR.
 *
 * Token: a fine-grained personal access token (or GitHub App) limited to the
 * one website repository, with Contents: read & write and Pull requests:
 * read & write. Nothing else.
 */

export interface GitHubConfig { owner: string; repo: string; token: string; baseBranch?: string; fetch?: typeof fetch }
export interface PullRequest { number: number; url: string; branch: string; draft: boolean }

export class GitHubSite {
  private f: typeof fetch;
  constructor(private cfg: GitHubConfig) {
    if (!/^[\w.-]+$/.test(cfg.owner) || !/^[\w.-]+$/.test(cfg.repo)) throw new Error('Bad owner/repo');
    this.f = cfg.fetch ?? fetch;
  }

  private async gh<T>(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<{ status: number; data: T }> {
    const r = await this.f(`https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}${path}`, {
      method, headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* raw file content */ }
    return { status: r.status, data };
  }

  async defaultBranch(): Promise<string> {
    if (this.cfg.baseBranch) return this.cfg.baseBranch;
    const r = await this.gh<{ default_branch: string }>('GET', '');
    if (r.status !== 200) throw new Error(`GitHub: cannot read repository (${r.status}). Check the token's repository access.`);
    return r.data.default_branch;
  }

  /** Raw file at a ref, or null if it does not exist. */
  async readFile(path: string, ref?: string): Promise<string | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const r = await this.gh<string>('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`, undefined, 'application/vnd.github.raw+json');
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`GitHub: cannot read ${path} (${r.status})`);
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }

  /** Paths of top-level route folders under app/, to avoid slug collisions. */
  async appRoutes(ref?: string): Promise<string[]> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const r = await this.gh<{ name: string; type: string }[]>('GET', `/contents/app${q}`);
    if (r.status !== 200 || !Array.isArray(r.data)) return [];
    return r.data.filter(x => x.type === 'dir').map(x => x.name);
  }

  async publicFiles(ref?: string): Promise<string[]> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const r = await this.gh<{ name: string; type: string }[]>('GET', `/contents/public${q}`);
    if (r.status !== 200 || !Array.isArray(r.data)) return [];
    return r.data.filter(x => x.type === 'file' && /\.(png|jpe?g|webp|avif)$/i.test(x.name)).map(x => '/' + x.name);
  }

  /** The commit the default branch points at now. Read files at this sha, then pass it to openPullRequest. */
  async headSha(): Promise<string> {
    const base = await this.defaultBranch();
    const ref = await this.gh<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(base)}`);
    if (ref.status !== 200) throw new Error(`GitHub: cannot read ${base} (${ref.status})`);
    return ref.data.object.sha;
  }

  /**
   * One atomic commit on a fresh branch, then a draft PR. If expectedBaseSha
   * is given and the branch has moved since the files were read, refuse:
   * committing would silently undo whatever landed in between.
   */
  async openPullRequest(o: { branch: string; title: string; body: string; message: string; files: { path: string; content: string }[]; expectedBaseSha?: string }): Promise<PullRequest> {
    if (!/^genai\/[a-z0-9][a-z0-9._/-]{2,80}$/.test(o.branch)) throw new Error('Branch must start with genai/ and use lower-case letters, digits, . _ / -');
    if (!o.files.length) throw new Error('Nothing to change');
    for (const f of o.files) if (f.path.includes('..') || f.path.startsWith('/') || /^\.github\//.test(f.path)) throw new Error(`Refusing to write ${f.path}`);
    const base = await this.defaultBranch();
    const ref = await this.gh<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(base)}`);
    if (ref.status !== 200) throw new Error(`GitHub: cannot read ${base} (${ref.status})`);
    const baseSha = ref.data.object.sha;
    if (o.expectedBaseSha && o.expectedBaseSha !== baseSha) throw new Error(`The website changed while the draft was being made (${base} moved). Run it again.`);
    const commit0 = await this.gh<{ tree: { sha: string } }>('GET', `/git/commits/${baseSha}`);
    if (commit0.status !== 200) throw new Error(`GitHub: cannot read commit ${baseSha} (${commit0.status})`);
    const tree = await this.gh<{ sha: string }>('POST', '/git/trees', {
      base_tree: commit0.data.tree.sha,
      tree: o.files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    if (tree.status !== 201) throw new Error(`GitHub: could not build the tree (${tree.status})`);
    const commit = await this.gh<{ sha: string }>('POST', '/git/commits', { message: o.message, tree: tree.data.sha, parents: [baseSha] });
    if (commit.status !== 201) throw new Error(`GitHub: could not commit (${commit.status})`);
    const newRef = await this.gh('POST', '/git/refs', { ref: `refs/heads/${o.branch}`, sha: commit.data.sha });
    if (newRef.status === 422) throw new Error(`Branch ${o.branch} already exists`);
    if (newRef.status !== 201) throw new Error(`GitHub: could not create the branch (${newRef.status})`);
    const pr = await this.gh<{ number: number; html_url: string; draft: boolean }>('POST', '/pulls', { title: o.title, head: o.branch, base, body: o.body, draft: true });
    if (pr.status !== 201) throw new Error(`GitHub: could not open the pull request (${pr.status})`);
    return { number: pr.data.number, url: pr.data.html_url, branch: o.branch, draft: pr.data.draft };
  }
}
