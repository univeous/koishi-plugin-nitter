import {
  Argv,
  Channel,
  Context,
  Dict,
  Logger,
  Quester,
  Schema,
  segment,
} from "koishi";
import {} from "koishi-plugin-puppeteer";
import { Page } from "puppeteer-core";
import { parse } from "rss-to-json";

declare module "." {
  interface NitterChannel {
    tweet?: NitterNotifiction[];
  }
}

interface NitterNotifiction {
  botId: string;
  nitterId: string;
  lastUpdated?: number;
}

type NitterTweetItem = {
  link: string;
  author: string;
  description: string;
  title: string;
  published: number;
};

export interface Config {
  endpoint: string;
  interval: number;
  image: boolean;
  showXlink: boolean;
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .description("nitter 实例终结点。")
    .default("https://nitter.cz"),
  interval: Schema.number().description("请求之间的间隔 (秒)。").default(10),
  image: Schema.boolean()
    .description("是否渲染为图片 (该选项依赖 puppeteer 插件)。")
    .default(true),
  showXlink: Schema.boolean()
    .description("是否发送原始推文链接。")
    .default(true),
});

export const logger = new Logger("nitter/nitter");

export async function apply(ctx: Context, config: Config) {
  const channels = await ctx.database.get("channel", {}, [
    "id",
    "guildId",
    "platform",
    "nitter",
  ]);
  const list = channels
    .filter((channel) => channel.nitter.tweet)
    .reduce((acc, x) => {
      x.nitter.tweet.forEach((notification) => {
        (acc[notification.nitterId] ||= []).push([x, notification]);
      });
      return acc;
    }, {} as Dict<[Pick<Channel, "id" | "guildId" | "platform" | "nitter">, NitterNotifiction][]>);

  ctx
    .guild()
    .command("nitter/tweet.add <uid:string>", "添加对 Twitter 用户的推文监听", {
      checkArgCount: true,
      authority: 2,
    })
    .channelFields(["id", "guildId", "platform", "nitter"])
    .before(checkTweet)
    .action(async ({ session }, uid) => {
      if (
        session.channel.nitter.tweet.find(
          (notification) => notification.nitterId === uid
        )
      ) {
        return "该用户已在监听列表中。";
      }
      let items: NitterTweetItem[];
      try {
        items = await request(uid, ctx.http, config);
      } catch (e) {
        return "请求失败，请检查 UID 是否正确或重试。";
      }
      const notification: NitterNotifiction = {
        botId: `${session.platform}:${
          session.bot.userId || session.bot.selfId
        }`,
        nitterId: uid,
      };
      session.channel.nitter.tweet.push(notification);
      (list[uid] ||= []).push([
        {
          id: session.channel.id,
          guildId: session.channel.guildId,
          platform: session.platform,
          nitter: session.channel.nitter,
        },
        notification,
      ]);
      return "添加成功。";
    });

  ctx
    .guild()
    .command(
      "nitter/tweet.remove <uid:string>",
      "删除对 Twitter 用户的推文监听",
      { checkArgCount: true, authority: 2 }
    )
    .channelFields(["id", "guildId", "platform", "nitter"])
    .before(checkTweet)
    .action(({ session }, uid) => {
      const { channel } = session;
      const index = channel.nitter.tweet.findIndex(
        (notification) => notification.nitterId === uid
      );
      if (index === -1) return "该用户不在监听列表中。";
      channel.nitter.tweet.splice(index, 1);
      const listIndex = list[uid].findIndex(
        ([{ id, guildId, platform }, notification]) => {
          return (
            channel.id === id &&
            channel.guildId === guildId &&
            channel.platform === platform &&
            notification.nitterId === uid
          );
        }
      );
      if (listIndex === -1) throw new Error("Data is out of sync.");
      list[uid].splice(listIndex, 1);
      return "删除成功。";
    });

  ctx
    .guild()
    .command("nitter/tweet.list", "列出当前监听 Twitter 用户列表", {
      authority: 2,
    })
    .channelFields(["nitter"])
    .before(checkTweet)
    .action(({ session }) => {
      if (session.channel.nitter.tweet.length === 0) return "监听列表为空。";
      return session.channel.nitter.tweet
        .map((notification) => "·" + notification.nitterId)
        .join("\n");
    });

  function checkTweet({ session }: Argv<never, "nitter">) {
    session.channel.nitter.tweet ||= [];
  }

  async function* listen() {
    while (true) {
      const entries = Object.entries(list);
      if (entries.length === 0) {
        yield;
        continue;
      }
      for (const [uid, notifications] of entries) {
        if (notifications.length === 0) continue;
        const time = notifications[0][1].lastUpdated;
        try {
          const items = await request(uid, ctx.http, config);
          if (!notifications[0][1].lastUpdated) {
            notifications.forEach(
              ([, notification]) =>
                (notification.lastUpdated = items[0]?.published || +new Date())
            );
            continue;
          }
          let neo = items.filter((item) => item.published > time);
          if (neo.length !== 0) {
            let rendered: string[];
            if (ctx.puppeteer && config.image) {
              rendered = await Promise.all(
                neo.map((item) => renderImage(ctx, config, item))
              );
            } else {
              rendered = neo.map((item) => renderText(config, item));
            }
            rendered.forEach((text, index) => {
              notifications.forEach(([channel, notification]) => {
                notification.lastUpdated = neo[index].published;
                ctx.bots[notification.botId].sendMessage(
                  channel.id,
                  text,
                  channel.guildId
                );
              });
            });
          }
        } catch (e) {
          logger.error(e);
        }
        yield;
      }
    }
  }

  const generator = listen();
  ctx.setInterval(async () => {
    await generator.next();
  }, config.interval * 1000);
}

async function renderImage(
  ctx: Context,
  config: Config,
  item: NitterTweetItem
): Promise<string> {
  let page: Page;
  try {
    page = await ctx.puppeteer.page();
    await page.setViewport({ width: 1920 * 2, height: 1080 * 2 });
    await page.goto(item.link);
    await page.waitForNetworkIdle();

    await (await page.$('form#reqform input[type="submit"]'))?.click();
    await page.waitForNetworkIdle();

    const element = await page.$(".timeline-item");
    console.log(element);

    return (
      `${item.author} 发布了推文:\n` +
      segment.image(await element.screenshot()) +
      `\n${
        config.showXlink
          ? item.link.replace(config.endpoint, "https://x.com")
          : item.link
      }`
    );
  } catch (e) {
    throw e;
  } finally {
    page?.close();
  }
}

async function request(
  uid: string,
  http: Quester,
  config: Config
): Promise<NitterTweetItem[]> {
  const res = await parse(`${config.endpoint}/${uid}/rss`);
  return res.items as NitterTweetItem[];
}

function renderText(config: Config, item: NitterTweetItem): string {
  return `${item.author} 发布了推文:\n${item.title}\n${
    config.showXlink
      ? item.link.replace(config.endpoint, "https://x.com")
      : item.link
  }`;
}
