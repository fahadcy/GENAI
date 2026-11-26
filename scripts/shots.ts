/**
 * Screenshot harness. Not part of the product — a development aid for reviewing
 * every surface in both themes without clicking through the app by hand.
 *
 * Usage: npx tsx scripts/shots.ts <sessionToken> <path> [path...]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '/tmp/shots'

async function main() {
  const [token, ...paths] = process.argv.slice(2)
  if (!token || paths.length === 0) {
    console.error('usage: tsx scripts/shots.ts <token> <path>...')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1560, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    })
    await ctx.addCookies([
      { name: 'aurea_session', value: token, domain: 'localhost', path: '/' },
    ])
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(String(e)))

    for (const path of paths) {
      const name = path.replace(/^\//, '').replace(/[/?=&]/g, '_') || 'home'
      const res = await page.goto(`http://localhost:3000${path}`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      })
      await page.waitForTimeout(700)
      const file = `${OUT}/${name}.${theme}.png`
      await page.screenshot({ path: file, fullPage: false })
      console.log(`${res?.status()} ${path} [${theme}] → ${file}`)
    }
    if (errors.length) {
      console.log(`\n  browser errors (${theme}):`)
      for (const e of [...new Set(errors)].slice(0, 8)) console.log(`   • ${e.slice(0, 220)}`)
    }
    await ctx.close()
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
