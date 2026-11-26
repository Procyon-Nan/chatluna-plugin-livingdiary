import type { Context } from 'cordis'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import type { Config } from '../config.js'
import { deletePosts, MAX_RECENT, type DeleteInput } from './deletion.js'
import type { QzoneService } from './service.js'

export function registerDeleteTool(ctx: Context, config: Pick<Config, 'allowUserIds'>, qzone: QzoneService, stopping: AbortSignal) {
    ctx.tools.define<DeleteInput>({
        name: 'qzone_delete',
        description: 'Delete only the bot’s own Qzone posts at the current requester’s instruction. Supply exactly one of id or recent. Resolve descriptions with qzone_list_feeds(scope=self); ask the user if ambiguous. For the latest N, call once with recent to delete those posts directly. Do not split a recent request into individual IDs or retry an uncertain deletion.',
        locales: { zh: { description: '删除机器人自己的指定动态，或直接删除最近几条动态。' } },
        args: Schema.object({
            id: Schema.string().pattern(/\S/).description('Exact post ID; not a list position.'),
            recent: Schema.natural().min(1).max(MAX_RECENT).description('Number of recent posts to delete directly.')
        }),
        traits: { effect: 'write', parallel: false, background: false },
        async run(input, call) {
            requireRequester(call, config.allowUserIds)
            return deletePosts(qzone, input, AbortSignal.any([call.signal, stopping]))
        }
    })
}
