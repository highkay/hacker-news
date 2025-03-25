import { keepDays, podcastDescription, podcastTitle } from '@/config'
import { getPastDays } from '@/lib/utils'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import markdownit from 'markdown-it'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { Podcast } from 'podcast'

const md = markdownit()

export const revalidate = 300

export async function GET() {
  const headersList = await headers()
  const host = headersList.get('host')

  const feed = new Podcast({
    title: podcastTitle,
    description: podcastDescription,
    feedUrl: `https://${host}/blog.xml`,
    siteUrl: `https://${host}`,
    imageUrl: `https://${host}/logo.jpg`,
    language: 'zh-CN',
    pubDate: new Date(),
    ttl: 60,
    generator: podcastTitle,
    author: podcastTitle,
    categories: ['technology', 'news'],
  })

  const { env } = getCloudflareContext()
  const runEnv = env.NEXTJS_ENV
  const pastDays = getPastDays(keepDays)
  const sources = ['hacker-news', 'linux-do', 'v2ex']

  // 获取所有来源的文章
  const allPosts = (await Promise.all(
    pastDays.flatMap(async (day) => {
      return await Promise.all(
        sources.map(async (source) => {
          const post = await env.HACKER_NEWS_KV.get(`content:${runEnv}:${source}:${day}`, 'json')
          return post as unknown as Article
        }),
      )
    }),
  )).flat().filter(Boolean)

  // 按日期倒序排序
  allPosts.sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.date).getTime()
    const dateB = new Date(b.updatedAt || b.date).getTime()
    return dateB - dateA
  })

  for (const post of allPosts) {
    const audioInfo = await env.HACKER_NEWS_R2.head(post.audio)

    feed.addItem({
      title: post.title || '',
      description: post.introContent || post.podcastContent || '',
      content: md.render(post.blogContent || ''),
      url: `https://${host}/post/${post.date}`,
      guid: `https://${host}/post/${post.date}`,
      date: new Date(post.updatedAt || post.date),
      enclosure: {
        url: `${env.NEXT_STATIC_HOST}/${post.audio}?t=${post.updatedAt}`,
        type: 'audio/mpeg',
        size: audioInfo?.size,
      },
    })
  }

  return new NextResponse(feed.buildXml(), {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': `public, max-age=${revalidate}, s-maxage=${revalidate}`,
    },
  })
}
