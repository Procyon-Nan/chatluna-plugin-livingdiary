import type { Context } from 'cordis'
import type {} from '@chatluna/tool'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneManager } from '../qzone/manager.js'
import { publishPost, type PublishInput } from './publish.js'

export function registerPublishTool(ctx: Context, config: Config, qzone: Pick<QzoneManager, 'publish'>) {
    ctx.tools.define<PublishInput>({
        name: 'qzone_publish',
        description: 'Publish a post to the bot’s QQ Space for the requesting user. Use image addresses from this conversation.',
        locales: { zh: { description: '将本次对话提供的正文和图片发布到机器人的 QQ 空间。' } },
        args: Schema.object({
            content: Schema.string().required().description('Post text; pass an empty string for an image-only post.'),
            images: Schema.array(Schema.string()).description('Up to 9 image references from the conversation.')
        }),
        traits: { effect: 'write', parallel: false, background: false },
        async run(input, call) {
            requireRequester(call, config.allowUserIds)
            return publishPost(ctx, qzone, input, call.signal)
        }
    })
}
