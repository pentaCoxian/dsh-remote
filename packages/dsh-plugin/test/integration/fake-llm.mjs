// Scripted OpenAI-compatible chat-completions endpoint for driving real DSH
// turns without a model: a prompt containing TOOL_TRIGGER gets one `glob`
// tool call, a tool result gets a short final answer, a prompt containing
// SLOW_TRIGGER is answered after 45 s (time to put the phone away, for
// notifications), anything else echoes.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4398);
const TOOL_TRIGGER = 'please-use-a-tool';
const SLOW_TRIGGER = 'please-take-your-time';
const SLOW_MS = 45_000;

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
  if (prompt.split('\n').at(-1)?.includes(SLOW_TRIGGER)) return { text: 'Done after a long think.\nThe rest of the reply.', delayMs: SLOW_MS };
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
    for (const word of step.text.split(/(?<= )/)) send(chunk({ role: 'assistant', content: word }));
    send(chunk({}, 'stop'));
  }
  send({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}
