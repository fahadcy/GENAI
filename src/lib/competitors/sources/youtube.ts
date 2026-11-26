import 'server-only'
import { env } from '@/lib/env'
import type { SocialProfile } from '../types'
import { apiJson } from './http'

/**
 * YouTube Data API v3. A channel lookup costs one quota unit; we never call
 * `search.list` (100 units) because the channel comes from the competitor's
 * own website link.
 */

type Channels = {
  items?: {
    id: string
    snippet?: { title?: string; customUrl?: string }
    statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }
    contentDetails?: { relatedPlaylists?: { uploads?: string } }
  }[]
}
type PlaylistItems = {
  items?: { snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }[]
}
type Videos = { items?: { id: string; statistics?: { viewCount?: string } }[] }

const API = 'https://www.googleapis.com/youtube/v3'

/** `handle` is "@name", a channel id "UC…", or a legacy username. */
export async function youtubeChannel(handle: string, url: string): Promise<SocialProfile | null> {
  const key = env().YOUTUBE_API_KEY
  if (!key) return null
  const q = new URLSearchParams({ part: 'snippet,statistics,contentDetails', key })
  if (handle.startsWith('@')) q.set('forHandle', handle)
  else if (/^UC[\w-]{20,}$/.test(handle)) q.set('id', handle)
  else q.set('forUsername', handle)

  const ch = await apiJson<Channels>('YouTube', `${API}/channels?${q}`)
  const c = ch.items?.[0]
  if (!c) return null

  const uploads = c.contentDetails?.relatedPlaylists?.uploads
  let recent: SocialProfile['recent'] = []
  if (uploads) {
    const pl = await apiJson<PlaylistItems>(
      'YouTube',
      `${API}/playlistItems?${new URLSearchParams({ part: 'snippet', playlistId: uploads, maxResults: '8', key })}`,
    )
    const ids = (pl.items ?? []).map((i) => i.snippet?.resourceId?.videoId).filter(Boolean) as string[]
    const views = new Map<string, number>()
    if (ids.length) {
      const v = await apiJson<Videos>('YouTube', `${API}/videos?${new URLSearchParams({ part: 'statistics', id: ids.join(','), key })}`)
      for (const it of v.items ?? []) views.set(it.id, Number(it.statistics?.viewCount ?? 0))
    }
    recent = (pl.items ?? []).map((i) => {
      const id = i.snippet?.resourceId?.videoId ?? ''
      return {
        title: i.snippet?.title ?? '',
        url: `https://www.youtube.com/watch?v=${id}`,
        publishedAt: i.snippet?.publishedAt ?? null,
        views: views.get(id) ?? null,
      }
    })
  }

  return {
    network: 'youtube',
    url,
    handle: c.snippet?.customUrl ?? handle,
    followers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0),
    posts: Number(c.statistics?.videoCount ?? 0),
    recent,
    depth: 'posts',
  }
}
