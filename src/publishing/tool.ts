import type { Context } from 'cordis'
import type {} from '@chatluna/tool'
import type { ChatMessage } from '@chatluna/message'
import { fileRefTableOf } from '@chatluna/transform'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneManager } from '../qzone/manager.js'
import { publishPost, type PublishInput } from './publish.js'
import { isImageRef } from './media.js'

function filesOf(agent: object | undefined) {
    if (!agent || !('options' in agent) || !('session' in agent)) return
    const { options, session } = agent
    if (!options || typeof options !== 'object' || !('conversationKey' in options) ||
        typeof options.conversationKey !== 'string' || !options.conversationKey) return
    if (!session || typeof session !== 'object' || !('messages' in session) || typeof session.messages !== 'function') return
    return fileRefTableOf((session as { messages(): readonly ChatMessage[] }).messages())
}

export function registerPublishTool(ctx: Context, config: Config, qzone: Pick<QzoneManager, 'publish'>) {
    ctx.tools.define<PublishInput>({
        name: 'qzone_publish',
        description: 'Publish a post to the bot’s QQ Space for the requesting user. For chat images, pass the ref from <img ref="…"/>; the original image is resolved directly. Existing image URLs are also accepted.',
        locales: { zh: { description: '将本次对话提供的正文和图片发布到机器人的 QQ 空间。' } },
        args: Schema.object({
            content: Schema.string().required().description('Post text; pass an empty string for an image-only post.'),
            images: Schema.array(Schema.string()).description('Up to 9 image refs such as i121cad from this conversation, or image addresses. Prefer refs; calling look to obtain a URL is unnecessary.')
        }),
        traits: { effect: 'write', parallel: false, background: false },
        async run(input, call) {
            requireRequester(call, config.allowUserIds)
            const files = input.images?.some(isImageRef) ? filesOf(call.agent) : undefined
            return publishPost(ctx, qzone, input, call.signal, files)
        }
    })
}
