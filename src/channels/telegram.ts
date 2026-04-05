import { Bot } from 'grammy';
import type { Channel, NewMessage } from '../types.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';
import { logger } from '../logger.js';

const MAX_MESSAGE_LENGTH = 4096;

class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private opts: ChannelOpts;
  private connected = false;

  constructor(token: string, opts: ChannelOpts) {
    this.opts = opts;
    this.bot = new Bot(token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.command('chatid', (ctx) => {
      const jid = `tg:${ctx.chat.id}`;
      ctx.reply(`Chat JID: ${jid}`).catch((err) => {
        logger.error({ err }, 'telegram: failed to reply to /chatid');
      });
    });

    this.bot.on('message:text', (ctx) => {
      const msg = ctx.message;
      const chatId = ctx.chat.id;
      const jid = `tg:${chatId}`;

      const chatName =
        ctx.chat.type === 'private'
          ? ctx.from?.first_name ?? 'DM'
          : (ctx.chat as { title?: string }).title ?? 'Unknown Group';

      const senderName = [ctx.from?.first_name, ctx.from?.last_name]
        .filter(Boolean)
        .join(' ') || 'Unknown';

      const newMessage: NewMessage = {
        id: String(msg.message_id),
        chat_jid: jid,
        sender: String(ctx.from?.id ?? 0),
        sender_name: senderName,
        content: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
        is_from_me: false,
        is_bot_message: false,
        reply_to_message_id: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
        reply_to_message_content:
          msg.reply_to_message && 'text' in msg.reply_to_message
            ? (msg.reply_to_message.text as string | undefined)
            : undefined,
        reply_to_sender_name: msg.reply_to_message?.from
          ? [msg.reply_to_message.from.first_name, msg.reply_to_message.from.last_name]
              .filter(Boolean)
              .join(' ') || undefined
          : undefined,
      };

      const isGroup = ctx.chat.type !== 'private';
      this.opts.onChatMetadata(jid, newMessage.timestamp, chatName, 'telegram', isGroup);
      this.opts.onMessage(jid, newMessage);
    });

    this.bot.catch((err) => {
      logger.error({ err: err.error }, 'telegram: bot error');
    });
  }

  async connect(): Promise<void> {
    logger.info('telegram: starting bot polling');
    // bot.start() runs forever; we fire-and-forget and track state
    this.bot.start({
      onStart: () => {
        this.connected = true;
        logger.info('telegram: bot polling started');
      },
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^tg:/, '');
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.bot.stop();
    logger.info('telegram: bot stopped');
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline within limit
    let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx <= 0) splitIdx = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramChannel(token, opts);
});
