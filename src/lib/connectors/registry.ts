/**
 * Connector catalogue (PRD 9).
 *
 * Every integration is described here and implemented behind one interface, so
 * adding a real vendor later is a new adapter file — not a change to the
 * scheduler, the segment sync or the metrics pipeline. That abstraction is the
 * stated mitigation for "integration breadth is underestimated" (PRD 12).
 */
export type ConnectorCategory = 'crm' | 'esp' | 'social' | 'ads' | 'analytics'

export type ConnectorCapability =
  | 'publish'
  | 'audience_sync'
  | 'metrics'
  | 'contact_import'
  | 'suppression_sync'

export type ConnectorDef = {
  provider: string
  displayName: string
  category: ConnectorCategory
  channels: string[]
  capabilities: ConnectorCapability[]
  authType: 'oauth2' | 'api_key' | 'basic'
  description: string
  /** Priority connectors for the first release (PRD 9). */
  firstRelease: boolean
  docsUrl?: string
}

export const CONNECTORS: ConnectorDef[] = [
  {
    provider: 'salesforce',
    displayName: 'Salesforce',
    category: 'crm',
    channels: [],
    capabilities: ['contact_import', 'audience_sync', 'metrics', 'suppression_sync'],
    authType: 'oauth2',
    description: 'Contacts, lifecycle stages and closed-won outcomes for attribution.',
    firstRelease: true,
  },
  {
    provider: 'hubspot_crm',
    displayName: 'HubSpot CRM',
    category: 'crm',
    channels: [],
    capabilities: ['contact_import', 'audience_sync', 'metrics', 'suppression_sync'],
    authType: 'oauth2',
    description: 'Two-way contact sync and pipeline outcomes.',
    firstRelease: true,
  },
  {
    provider: 'segment_cdp',
    displayName: 'Segment CDP',
    category: 'crm',
    channels: [],
    capabilities: ['contact_import', 'audience_sync'],
    authType: 'api_key',
    description: 'Unified customer profiles and traits.',
    firstRelease: false,
  },
  {
    provider: 'sendgrid',
    displayName: 'SendGrid',
    category: 'esp',
    channels: ['email'],
    capabilities: ['publish', 'metrics', 'suppression_sync'],
    authType: 'api_key',
    description: 'Transactional and campaign email delivery.',
    firstRelease: true,
  },
  {
    provider: 'wordpress',
    displayName: 'WordPress',
    category: 'esp',
    channels: ['blog', 'web'],
    capabilities: ['publish'],
    authType: 'basic',
    description: 'Publishes approved posts to your own website over the built-in REST API. No plugin needed.',
    firstRelease: true,
    docsUrl: 'https://developer.wordpress.org/rest-api/reference/posts/',
  },
  {
    provider: 'clicksend',
    displayName: 'ClickSend',
    category: 'esp',
    channels: ['sms'],
    capabilities: ['publish', 'metrics'],
    authType: 'basic',
    description: 'SMS delivery, priced per message, with per-recipient delivery status.',
    firstRelease: true,
    docsUrl: 'https://developers.clicksend.com/docs/rest/v3/',
  },
  {
    provider: 'twilio',
    displayName: 'Twilio',
    category: 'esp',
    channels: ['sms'],
    capabilities: ['publish', 'metrics'],
    authType: 'api_key',
    description: 'SMS delivery with per-country compliance rules.',
    firstRelease: false,
  },
  {
    provider: 'firebase_push',
    displayName: 'Firebase Cloud Messaging',
    category: 'esp',
    channels: ['push'],
    capabilities: ['publish', 'metrics'],
    authType: 'api_key',
    description: 'Mobile and web push notifications.',
    firstRelease: false,
  },
  {
    provider: 'linkedin_pages',
    displayName: 'LinkedIn Pages',
    category: 'social',
    channels: ['linkedin'],
    capabilities: ['publish', 'metrics'],
    authType: 'oauth2',
    description: 'Organic company-page publishing and engagement metrics.',
    firstRelease: true,
  },
  {
    provider: 'meta_business',
    displayName: 'Meta Business Suite',
    category: 'social',
    channels: ['facebook', 'instagram'],
    capabilities: ['publish', 'metrics'],
    authType: 'oauth2',
    description: 'Facebook and Instagram publishing.',
    firstRelease: true,
  },
  {
    provider: 'x_api',
    displayName: 'X',
    category: 'social',
    channels: ['x'],
    capabilities: ['publish', 'metrics'],
    authType: 'oauth2',
    description: 'Post publishing and engagement metrics.',
    firstRelease: false,
  },
  {
    provider: 'google_ads',
    displayName: 'Google Ads',
    category: 'ads',
    channels: ['google_ads'],
    capabilities: ['publish', 'audience_sync', 'metrics'],
    authType: 'oauth2',
    description: 'Customer Match audiences, responsive search ads and spend signals.',
    firstRelease: true,
  },
  {
    provider: 'meta_ads',
    displayName: 'Meta Ads',
    category: 'ads',
    channels: ['meta_ads'],
    capabilities: ['publish', 'audience_sync', 'metrics'],
    authType: 'oauth2',
    description: 'Custom Audiences and paid social delivery.',
    firstRelease: true,
  },
  {
    provider: 'ga4',
    displayName: 'Google Analytics 4',
    category: 'analytics',
    channels: [],
    capabilities: ['metrics'],
    authType: 'oauth2',
    description: 'Downstream web conversions for attribution.',
    firstRelease: true,
  },
  {
    provider: 'amplitude',
    displayName: 'Amplitude',
    category: 'analytics',
    channels: [],
    capabilities: ['metrics'],
    authType: 'api_key',
    description: 'Product analytics events and activation funnels.',
    firstRelease: false,
  },
]

export const CONNECTOR_BY_PROVIDER = new Map(CONNECTORS.map((c) => [c.provider, c]))

export function connectorsForChannel(channel: string): ConnectorDef[] {
  return CONNECTORS.filter((c) => c.channels.includes(channel))
}

export const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  crm: 'CRM & CDP',
  esp: 'Email, SMS & push',
  social: 'Social',
  ads: 'Advertising',
  analytics: 'Analytics',
}
