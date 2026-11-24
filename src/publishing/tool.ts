import type { Context } from 'cordis'
import type {} from '@chatluna/tool'
import type { ChatMessage } from '@chatluna/message'
import { fileRefTableOf } from '@chatluna/transform'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneManager } from '../qzone/manager.js'
import { publishPost, type PublishInput } from './publish.js'
import { isMediaRef } from './media.js'

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
        description: 'Publish one post to the bot’s QQ Space for the requesting user. Write the requested caption and pass images and MP4 videos together. Use refs from <img ref="…"/> and <video ref="…"/> to upload the original files; previews and covers are not upload inputs. Media URLs are also accepted.',
        locales: { zh: { description: '按本次请求者的要求撰写正文，将对话中的图片和 MP4 视频一起发布为一条 QQ 空间动态。' } },
        args: Schema.object({
            content: Schema.string().required().description('Complete post text; write a caption if requested, or pass an empty string for media only.'),
            images: Schema.array(Schema.string()).description('Up to 9 image refs such as i121cad from this conversation, or image addresses. Prefer refs; calling look to obtain a URL is unnecessary. Each image is limited to 32 MiB.'),
            videos: Schema.array(Schema.string()).description('MP4 video refs from this conversation, or original video URLs. Prefer refs and preserve the requested order. Each video is limited to 128 MiB; do not use cover images or player-page URLs.')
        }),
        traits: { effect: 'write', parallel: false, background: false },
        async run(input, call) {
            requireRequester(call, config.allowUserIds)
            const files = input.images?.some(isMediaRef) || input.videos?.some(isMediaRef) ? filesOf(call.agent) : undefined
            return publishPost(ctx, qzone, input, call.signal, files)
        }
    })
}
