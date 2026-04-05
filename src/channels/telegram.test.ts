import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- grammy mock ---

const mockSendMessage = vi.fn().mockResolvedValue({});
const handlers: Record<string, Function> = {};
let startOpts: { onStart?: () => void } | undefined;
const mockStop = vi.fn();
let errorHandler: Function | undefined;

vi.mock('grammy', () => {
  class MockBot {
    command(cmd: string, handler: Function) {
      handlers[`command:${cmd}`] = handler;
    }
    on(filter: string, handler: Function) {
      handlers[filter] = handler;
    }
    catch(handler: Function) {
      errorHandler = handler;
    }
    start(opts?: { onStart?: () => void }) {
      startOpts = opts;
      opts?.onStart?.();
    }
    stop = mockStop;
    api = { sendMessage: mockSendMessage };
  }
  return { Bot: MockBot };
});

// Must import AFTER mocks are defined
import { getChannelFactory, getRegisteredChannelNames } from './registry.js';
import './telegram.js';

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
  };
}

describe('telegram channel', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers['command:chatid'] = () => {};
    handlers['message:text'] = () => {};
    errorHandler = undefined;
    startOpts = undefined;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('registers itself in the channel registry', () => {
    expect(getRegisteredChannelNames()).toContain('telegram');
  });

  it('factory returns null when TELEGRAM_BOT_TOKEN is not set', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const factory = getChannelFactory('telegram')!;
    const channel = factory(makeOpts());
    expect(channel).toBeNull();
  });

  it('factory returns a channel when TELEGRAM_BOT_TOKEN is set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const factory = getChannelFactory('telegram')!;
    const channel = factory(makeOpts());
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('telegram');
  });

  describe('with channel instance', () => {
    function createChannel() {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      const opts = makeOpts();
      const factory = getChannelFactory('telegram')!;
      const channel = factory(opts)!;
      return { channel, opts };
    }

    it('ownsJid returns true for tg: prefix', () => {
      const { channel } = createChannel();
      expect(channel.ownsJid('tg:123456')).toBe(true);
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('ownsJid returns false for non-tg: jids', () => {
      const { channel } = createChannel();
      expect(channel.ownsJid('wa:123@s.whatsapp.net')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });

    it('connect starts polling and sets connected', async () => {
      const { channel } = createChannel();
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('sendMessage extracts chat ID and sends', async () => {
      const { channel } = createChannel();
      await channel.sendMessage('tg:123456', 'Hello');
      expect(mockSendMessage).toHaveBeenCalledWith('123456', 'Hello');
    });

    it('sendMessage splits long messages', async () => {
      const { channel } = createChannel();
      const longText = 'a'.repeat(5000);
      await channel.sendMessage('tg:123', longText);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First chunk should be max length
      const firstChunk = mockSendMessage.mock.calls[0][1] as string;
      expect(firstChunk.length).toBeLessThanOrEqual(4096);
    });

    it('/chatid command replies with jid', () => {
      createChannel();
      const mockReply = vi.fn().mockResolvedValue({});
      const ctx = { chat: { id: -1001234567890 }, reply: mockReply };
      handlers['command:chatid'](ctx);
      expect(mockReply).toHaveBeenCalledWith('Chat JID: tg:-1001234567890');
    });

    it('message:text handler calls onMessage with correct format', () => {
      const { opts } = createChannel();
      const ctx = {
        message: {
          message_id: 42,
          text: 'Hello bot',
          date: 1700000000,
          reply_to_message: undefined,
        },
        chat: { id: 123456, type: 'private' },
        from: { id: 789, first_name: 'Alice', last_name: 'Smith' },
      };
      handlers['message:text'](ctx);

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const [jid, msg] = opts.onMessage.mock.calls[0];
      expect(jid).toBe('tg:123456');
      expect(msg.id).toBe('42');
      expect(msg.chat_jid).toBe('tg:123456');
      expect(msg.sender).toBe('789');
      expect(msg.sender_name).toBe('Alice Smith');
      expect(msg.content).toBe('Hello bot');
      expect(msg.is_from_me).toBe(false);
    });

    it('message:text handler includes reply context', () => {
      const { opts } = createChannel();
      const ctx = {
        message: {
          message_id: 50,
          text: 'replying',
          date: 1700000000,
          reply_to_message: {
            message_id: 49,
            text: 'original message',
            from: { first_name: 'Bob', last_name: undefined },
          },
        },
        chat: { id: -100999, type: 'group', title: 'Test Group' },
        from: { id: 789, first_name: 'Alice', last_name: undefined },
      };
      handlers['message:text'](ctx);

      const [, msg] = opts.onMessage.mock.calls[0];
      expect(msg.reply_to_message_id).toBe('49');
      expect(msg.reply_to_message_content).toBe('original message');
      expect(msg.reply_to_sender_name).toBe('Bob');
    });

    it('message:text handler calls onChatMetadata', () => {
      const { opts } = createChannel();
      const ctx = {
        message: { message_id: 1, text: 'hi', date: 1700000000, reply_to_message: undefined },
        chat: { id: -100999, type: 'group', title: 'My Group' },
        from: { id: 1, first_name: 'User', last_name: undefined },
      };
      handlers['message:text'](ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:-100999',
        expect.any(String),
        'My Group',
        'telegram',
        true,
      );
    });

    it('disconnect stops the bot', async () => {
      const { channel } = createChannel();
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockStop).toHaveBeenCalled();
    });
  });
});
