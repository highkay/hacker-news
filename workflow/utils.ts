import * as cheerio from 'cheerio'
import { XMLParser } from 'fast-xml-parser'
// 移除 JSDOM 相关的导入
// import { JSDOM } from 'jsdom'

// 创建 XML 解析器实例
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: 'text',
})

export async function getHackerNewsTopStories(today: string, JINA_KEY?: string) {
  const url = `https://news.ycombinator.com/front?day=${today}`
  const headers: HeadersInit = {
    'X-Retain-Images': 'none',
    'X-Return-Format': 'html',
  }

  if (JINA_KEY) {
    headers.Authorization = `Bearer ${JINA_KEY}`
  }
  console.info(`get top stories ${today} from ${url}`)
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers,
  })
  console.info(`get top stories result: ${response.statusText}`)
  const text = await response.text()

  const $ = cheerio.load(text)
  const stories: Story[] = $('.athing.submission').map((i, el) => ({
    id: $(el).attr('id'),
    title: $(el).find('.titleline > a').text(),
    url: $(el).find('.titleline > a').attr('href'),
    hackerNewsUrl: `https://news.ycombinator.com/item?id=${$(el).attr('id')}`,
  })).get()

  return stories.filter(story => story.id && story.url)
}

export async function getHackerNewsStory(story: Story, maxTokens: number, JINA_KEY?: string) {
  const headers: HeadersInit = {
    'X-Retain-Images': 'none',
  }

  if (JINA_KEY) {
    headers.Authorization = `Bearer ${JINA_KEY}`
  }

  const [article, comments] = await Promise.all([
    fetch(`https://r.jina.ai/${story.url}`, {
      headers,
    }).then((res) => {
      if (res.ok) {
        return res.text()
      }
      else {
        console.error(`get story failed: ${res.statusText}  ${story.url}`)
        return ''
      }
    }),
    fetch(`https://r.jina.ai/https://news.ycombinator.com/item?id=${story.id}`, {
      headers: {
        ...headers,
        'X-Remove-Selector': '.navs',
        'X-Target-Selector': '#pagespace + tr',
      },
    }).then((res) => {
      if (res.ok) {
        return res.text()
      }
      else {
        console.error(`get story comments failed: ${res.statusText} https://news.ycombinator.com/item?id=${story.id}`)
        return ''
      }
    }),
  ])
  return [
    story.title
      ? `
<title>
${story.title}
</title>
`
      : '',
    article
      ? `
<article>
${article.substring(0, maxTokens * 4)}
</article>
`
      : '',
    comments
      ? `
<comments>
${comments.substring(0, maxTokens * 4)}
</comments>
`
      : '',
  ].filter(Boolean).join('\n\n---\n\n')
}

export async function getLinuxDoTopStories() {
  try {
    console.info('获取 Linux.do 热门帖子列表...')
    const response = await fetch('https://linux.do/top.rss?period=daily')
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const xmlText = await response.text()

    const result = parser.parse(xmlText)
    const items = result.rss.channel.item || []

    const stories: Story[] = items.map((item) => {
      // 直接访问解析后的对象属性
      const link = item.link || ''
      const title = item.title || ''
      const topicId = link.match(/\/topic\/(\d+)/)?.[1]

      return {
        id: topicId,
        title,
        url: link,
        hackerNewsUrl: link,
      }
    })

    console.info(`获取到 ${stories.length} 个 Linux.do 帖子`)
    return stories.filter(story => story.id && story.url)
  }
  catch (error) {
    console.error('获取 Linux.do RSS 失败:', error)
    return []
  }
}

export async function getLinuxDoStory(story: Story, maxTokens: number) {
  try {
    const response = await fetch(`https://linux.do/t/topic/${story.id}.rss`)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const xmlText = await response.text()

    const result = parser.parse(xmlText)
    const items = result.rss.channel.item || []

    // 第一个item是主贴内容
    const article = items[0]?.description || ''

    // 其余items是评论内容
    const comments = items
      .slice(1)
      .map(item => item.description || '')
      .join('\n')

    return [
      story.title
        ? `
<title>
${story.title}
</title>
`
        : '',
      article
        ? `
<article>
${article.substring(0, maxTokens * 4)}
</article>
`
        : '',
      comments
        ? `
<comments>
${comments.substring(0, maxTokens * 4)}
</comments>
`
        : '',
    ].filter(Boolean).join('\n\n---\n\n')
  }
  catch (error) {
    console.error('获取 Linux.do 帖子内容失败:', error)
    return ''
  }
}

export async function getV2exNewStories() {
  try {
    console.info('获取 V2EX 最新帖子列表...')
    // 使用更完整的 URL
    const response = await fetch('https://www.v2ex.com/feed/tab/all.xml')

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const xmlText = await response.text()
    console.info(`获取到的 XML 长度: ${xmlText.length}`)

    const result = parser.parse(xmlText)
    const items = result.rss?.channel?.item || []

    const stories: Story[] = items.map((item) => {
      const link = item.link || ''
      const title = item.title || ''
      const topicId = link.match(/\/t\/(\d+)/)?.[1]

      return {
        id: topicId,
        title,
        url: link,
        hackerNewsUrl: link,
      }
    })

    console.info(`获取到 ${stories.length} 个 V2EX 帖子`)
    return stories.filter(story => story.id && story.url)
  }
  catch (error) {
    console.error('获取 V2EX RSS 失败:', error)
    return []
  }
}

export async function getV2exStory(story: Story, maxTokens: number, JINA_KEY?: string) {
  const headers: HeadersInit = {
    'X-Retain-Images': 'none',
    'X-Remove-Selector': '#Top, #Bottom',
  }

  if (JINA_KEY) {
    headers.Authorization = `Bearer ${JINA_KEY}`
  }

  const [article, comments] = await Promise.all([
    fetch(`https://r.jina.ai/${story.url}`, {
      headers: {
        ...headers,
        'X-Target-Selector': '.topic_content',
      },
    }).then((res) => {
      if (res.ok) {
        return res.text()
      }
      else {
        console.error(`get story failed: ${res.statusText}  ${story.url}`)
        return ''
      }
    }),
    fetch(`https://r.jina.ai/${story.url}`, {
      headers: {
        ...headers,
        'X-Target-Selector': '.reply_content',
      },
    }).then((res) => {
      if (res.ok) {
        return res.text()
      }
      else {
        console.error(`get story comments failed: ${res.statusText}  ${story.url}`)
        return ''
      }
    }),
  ])
  return [
    story.title
      ? `
<title>
${story.title}
</title>
`
      : '',
    article
      ? `
<article>
${article.substring(0, maxTokens * 4)}
</article>
`
      : '',
    comments
      ? `
<comments>
${comments.substring(0, maxTokens * 4)}
</comments>
`
      : '',
  ].filter(Boolean).join('\n\n---\n\n')
}
