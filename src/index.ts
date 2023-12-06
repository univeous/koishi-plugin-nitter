import { Context, Quester, Schema } from 'koishi'
import * as nitter from './nitter'

export interface NitterChannel {}

declare module 'koishi' {
  interface Channel {
    nitter: NitterChannel
  }
}

export const name = 'nitter'

export const inject = {
  required: ['database'],
  optional: ['puppeteer'],
}

export interface Config {
  nitter: nitter.Config
  quester: Quester.Config
}

export const Config: Schema<Config> = Schema.object({
  nitter: nitter.Config,
  quester: Quester.Config
})

export function apply(context: Context, config: Config) {
  context.model.extend('channel', {
    nitter: {
      type: 'json',
      initial:{},
    }
  })

  const ctx = context.isolate(['http'])
  ctx.http = context.http.extend({
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      ...config.quester.headers,
    },
    ...config.quester,
  })

  ctx.plugin(nitter, config.nitter)
}
