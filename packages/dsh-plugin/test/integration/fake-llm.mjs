// Scripted OpenAI-compatible chat-completions endpoint for driving real DSH
// turns without a model: a prompt containing TOOL_TRIGGER gets one `glob`
// tool call, a tool result gets a short final answer, a prompt containing
// SLOW_TRIGGER is answered after 45 s (time to put the phone away, for
// notifications), one containing LONG_TRIGGER gets a long markdown reply (to
// build up a long session), anything else echoes.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4398);
const TOOL_TRIGGER = 'please-use-a-tool';
const SLOW_TRIGGER = 'please-take-your-time';
const SLOW_MS = 45_000;
const LONG_TRIGGER = 'please-write-at-length';

/** About 120 KB of markdown: sections of prose, lists and code. */
function longReply() {
  const parts = [];
  for (let i = 1; i <= 60; i++) {
    parts.push(`## Section ${i}\n`);
    for (let p = 0; p < 4; p++) parts.push(`Paragraph ${p + 1} of section ${i}. ${'The phone reads this through the tunnel, one stream at a time, while the page lays it out. '.repeat(4)}\n`);
    parts.push(`- point one of ${i}\n- point two of ${i}\n- point three of ${i}\n`);
    parts.push(`\`\`\`ts\nexport function section${i}(input: string): string {\n  return input.repeat(${i});\n}\n\`\`\`\n`);
  }
  return parts.join('\n');
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part.text ?? '').join('');
  return '';
}

function plan(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  if (last?.role === 'tool') return { text: 'Tool finished; all done.' };
  const prompt = messages.filter((m) => m.role === 'user').map(textOf).join('\n');
  if ((body.tools?.length ?? 0) > 0 && prompt.includes(TOOL_TRIGGER)) {
    return { tool: { id: `call_${Date.now()}`, name: 'glob', arguments: JSON.stringify({ pattern: '*.md' }) } };
  }
  // This turn's user messages: DSH adds its own context messages after the prompt.
  const lastReply = messages.findLastIndex((m) => m.role === 'assistant');
  const thisTurn = messages.slice(lastReply + 1).filter((m) => m.role === 'user').map(textOf);
  if (thisTurn.some((text) => text.includes(SLOW_TRIGGER))) {
    return { text: 'Done after a long think.\nThe rest of the reply.', delayMs: SLOW_MS };
  }
  if (thisTurn.some((text) => text.includes(LONG_TRIGGER))) return { text: longReply(), pieces: 400 };
  return { text: 'Scripted reply.' };
}

function chunk(delta, finishReason = null) {
  return { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw || '{}');
    const step = plan(body);
    setTimeout(() => respond(res, step), step.delayMs ?? 0);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake-llm listening on ${port}`));

function respond(res, step) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  if (step.tool) {
    send(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: step.tool.id, type: 'function', function: { name: step.tool.name, arguments: step.tool.arguments } }] }));
    send(chunk({}, 'tool_calls'));
  } else {
    const pieces = step.pieces === undefined ? step.text.split(/(?<= )/) : step.text.match(new RegExp(`[\\s\\S]{1,${step.pieces}}`, 'g'));
    for (const piece of pieces) send(chunk({ role: 'assistant', content: piece }));
    send(chunk({}, 'stop'));
  }
  send({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}
