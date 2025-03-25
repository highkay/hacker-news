import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import { podcastTitle } from '@/config'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { synthesize } from '@echristian/edge-tts'
import { generateText } from 'ai'
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { introPrompt, summarizeBlogPrompt, summarizePodcastPrompt, summarizeStoryPrompt } from './prompt'
import { getHackerNewsStory, getHackerNewsTopStories, getLinuxDoStory, getLinuxDoTopStories, getV2exNewStories, getV2exStory } from './utils'

interface Params {
  today?: string
}

const retryConfig: WorkflowStepConfig = {
  retries: {
    limit: 5,
    delay: '30 seconds',
    backoff: 'exponential',
  },
  timeout: '20 minutes',
}

export class HackerNewsWorkflow extends WorkflowEntrypoint<CloudflareEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    console.info('trigged event: HackerNewsWorkflow', event)

    const runEnv = this.env.NEXTJS_ENV || 'production'
    const isDev = runEnv === 'development'
    const today = event.payload.today || new Date().toISOString().split('T')[0]
    const openai = createOpenAICompatible({
      name: 'openai',
      baseURL: this.env.OPENAI_BASE_URL!,
      headers: {
        Authorization: `Bearer ${this.env.OPENAI_API_KEY!}`,
      },
    })
    const maxTokens = Number.parseInt(this.env.OPENAI_MAX_TOKENS || '4096')

    // 获取不同来源的内容
    const results = await Promise.allSettled([
      step.do(`get hacker news stories ${today}`, retryConfig, async () => {
        return await getHackerNewsTopStories(today, this.env.JINA_KEY)
      }),
      step.do(`get linux.do stories ${today}`, retryConfig, async () => {
        return await getLinuxDoTopStories()
      }),
      step.do(`get v2ex stories ${today}`, retryConfig, async () => {
        return await getV2exNewStories()
      }),
    ])

    // 为每个来源创建内容
    const sources = [
      { name: 'hacker-news', stories: [], getStory: getHackerNewsStory },
      { name: 'linux-do', stories: [], getStory: getLinuxDoStory },
      { name: 'v2ex', stories: [], getStory: getV2exStory },
    ]

    // 处理结果
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        sources[index].stories = result.value
      }
      else {
        console.error(`Failed to fetch stories for ${sources[index].name}:`, result.reason)
        sources[index].stories = []
      }
    })

    for (const source of sources) {
      if (!source.stories.length) {
        console.warn(`No stories found for ${source.name}`)
        continue
      }

      source.stories.length = Math.min(source.stories.length, isDev ? 5 : 10)
      const allStories: string[] = []

      for (const story of source.stories) {
        const storyResponse = await step.do(
          `get ${source.name} story ${story.id}: ${story.title}`,
          retryConfig,
          async () => {
            return await source.getStory(story, maxTokens, this.env.JINA_KEY)
          },
        )

        const text = await step.do(
          `summarize ${source.name} story ${story.id}`,
          retryConfig,
          async () => {
            const { text } = await generateText({
              model: openai(this.env.OPENAI_MODEL!),
              system: summarizeStoryPrompt(source.name), // 传入 source.name
              prompt: storyResponse,
            })
            return text
          },
        )

        allStories.push(text)
        await step.sleep('Give AI a break', isDev ? '2 seconds' : '10 seconds')
      }

      const podcastContent = await step.do(`create ${source.name} podcast content`, retryConfig, async () => {
        const { text } = await generateText({
          model: openai(this.env.OPENAI_MODEL!),
          system: summarizePodcastPrompt(source.name), // 传入 source.name
          prompt: allStories.join('\n\n---\n\n'),
          maxTokens,
          maxRetries: 3,
        })
        return text
      })

      const blogContent = await step.do(`create ${source.name} blog content`, retryConfig, async () => {
        const { text } = await generateText({
          model: openai(this.env.OPENAI_MODEL!),
          system: summarizeBlogPrompt(source.name), // 传入 source.name
          prompt: allStories.join('\n\n---\n\n'),
          maxTokens,
          maxRetries: 3,
        })
        return text
      })

      const introContent = await step.do(`create ${source.name} intro content`, retryConfig, async () => {
        const { text } = await generateText({
          model: openai(this.env.OPENAI_MODEL!),
          system: introPrompt(source.name), // 传入 source.name
          prompt: podcastContent,
          maxRetries: 3,
        })
        return text
      })

      const contentKey = `content:${runEnv}:${source.name}:${today}`
      const podcastKey = `${today.replaceAll('-', '/')}/${runEnv}/${source.name}-${today}.mp3`

      await step.do(`create ${source.name} podcast audio`, { ...retryConfig, timeout: '5 minutes' }, async () => {
        const { audio } = await synthesize({
          text: podcastContent,
          language: 'zh-CN',
          voice: this.env.AUDIO_VOICE_ID || 'zh-CN-XiaoxiaoNeural',
          rate: this.env.AUDIO_SPEED || '10%',
        })

        await this.env.HACKER_NEWS_R2.put(podcastKey, audio)

        const podcast = await this.env.HACKER_NEWS_R2.head(podcastKey)
        if (!podcast || podcast.size < audio.size) {
          throw new Error('podcast not found')
        }
        return 'OK'
      })

      await step.do(`save ${source.name} content to kv`, retryConfig, async () => {
        await this.env.HACKER_NEWS_KV.put(contentKey, JSON.stringify({
          date: today,
          title: `${podcastTitle} ${source.name} ${today}`,
          stories: source.stories,
          podcastContent,
          blogContent,
          introContent,
          audio: podcastKey,
          updatedAt: Date.now(),
        }))
        return 'OK'
      })

      console.info(`${source.name} workflow completed successfully`)
    }
  }
}
