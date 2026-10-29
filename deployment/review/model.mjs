// The review host's model: an OpenAI-compatible chat-completions endpoint with
// canned replies, so the reviewer can try DSH Web through the app without an
// API key behind it.
//   - a message with "notify" gets a tool call after 45 s, time to leave the
//     app (the host counts it gone 20 s after it closes): the approval it waits
//     for arrives as a notification;
//   - a message with "tool" gets a tool call at once, approved in DSH Web;
//   - anything else gets a short explanation.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4398);
const NOTIFY_DELAY_MS = 45_000;

const INTRO = [
  'This is the DSH Remote review host: DeepSeek Harness running with a scripted model, so its replies are canned.',
  'Everything around them is real: this page is DSH Web on the host, reached over an end-to-end encrypted connection.',
  'Send "please use a tool" to see a tool call wait for your approval.',
  'Send "notify me", then leave the app: about 45 seconds later the approval request arrives as a notification.',
].join('\n\n');

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part.text ?? '').join('');
  return '';
}

function plan(body) {
  const messages = body.messages ?? [];
  if (messages.at(-1)?.role === 'tool') return { text: 'That settles the tool call: tap its step above to see what happened. On your own host, your agent carries on from here.' };
  // This turn's user messages: DSH adds its own context after the prompt.
  const lastReply = messages.findLastIndex((m) => m.role === 'assistant');
  const prompt = messages.slice(lastReply + 1).filter((m) => m.role === 'user').map(textOf).join('\n').toLowerCase();
  // A harmless command asking for more than the session's sandbox allows, so DSH asks before it runs.
  const tool = {
    id: `call_${Date.now()}`,
    name: 'bash',
    arguments: JSON.stringify({
      description: 'Show where the review host runs',
      command: 'uname -a; whoami',
      sandbox_permissions: 'danger-full-access',
      justification: 'A demonstration: DSH asks you before a command leaves its sandbox.',
    }),
  };
  if ((body.tools?.length ?? 0) > 0 && prompt.includes('notify')) return { tool, delayMs: NOTIFY_DELAY_MS };
  if ((body.tools?.length ?? 0) > 0 && prompt.includes('tool')) return { tool };
  return { text: INTRO };
}

function chunk(delta, finishReason = null) {
  return { id: 'chatcmpl-review', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'review', choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function respond(res, step) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  if (step.tool) {
    send(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: step.tool.id, type: 'function', function: { name: step.tool.name, arguments: step.tool.arguments } }] }));
    send(chunk({}, 'tool_calls'));
  } else {
    for (const word of step.text.split(/(?<= )/)) send(chunk({ role: 'assistant', content: word }));
    send(chunk({}, 'stop'));
  }
  send({ ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (part) => {
    raw += part;
  });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const step = plan(JSON.parse(raw || '{}'));
    setTimeout(() => respond(res, step), step.delayMs ?? 0);
  });
}).listen(port, '127.0.0.1', () => console.log(`review model on ${port}`));
