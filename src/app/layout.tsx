import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ToastProvider, THEME_SCRIPT } from '@/components/ui/client'

export const metadata: Metadata = {
  title: {
    default: 'Aurea — one governed loop from brief to result',
    template: '%s · Aurea',
  },
  description:
    'Aurea is the GenAI marketing platform where a campaign is generated, reviewed, approved, published and optimised in one governed pipeline — with a full audit trail.',
  applicationName: 'Aurea',
  openGraph: {
    title: 'Aurea — one governed loop from brief to result',
    description:
      'Generate, review, approve, publish and optimise campaigns in one governed pipeline.',
    type: 'website',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafb' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0d12' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
