// routes/[...].ts
import { defineEventHandler, getRequestURL, getMethod, getRequestHeaders, readRawBody } from 'h3';

const PROXY_URL = 'https://api-preview.chatgot.io';

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const method = getMethod(event);
  
  // /v1/models
  if (url.pathname === '/v1/models') {
    return {
      data: [
        {
          id: "deepseek-v3",
          object: "model",
          created: 1677610602,
          owned_by: "openai"
        },
        {
          id: "deepseek-r1",
          object: "model",
          created: 1677610602,
          owned_by: "openai"
        }
      ],
      object: "list"
    };
  }

  // /v1/chat/completions
  if (url.pathname === '/v1/chat/completions' && method !== 'POST') {
    return {
      error: {
        message: "Invalid request. Please use POST /v1/chat/completions.",
        type: "invalid_request_error"
      }
    };
  }
  if (url.pathname === '/v1/chat/completions' && method === 'POST') {
    try {
      const body = await readRawBody(event);
      if (!body) throw new Error('Missing request body');
      
      const payload = JSON.parse(body);
      const { model, messages, stream = false } = payload;
      
      // Валидация модели
      let model_id: number;
      if (model === 'deepseek-r1') model_id = 1;
      else if (model === 'deepseek-v3') model_id = 2;
      else {
        event.res.statusCode = 400;
        return {
          error: {
            message: "Invalid model. Supported models: 'deepseek-r1', 'deepseek-v3'",
            type: "invalid_request_error"
          }
        };
      }

      // device_id
      const device_id = crypto.randomUUID();
      const targetUrl = `${PROXY_URL}/api/v1/char-gpt/conversations`;
      
      // запрос к целевому API
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          device_id,
          model_id,
          include_reasoning: true,
          messages
        })
      });

      // http-ошибки
      if (!res.ok) {
        const error = await res.text();
        event.res.statusCode = res.status;
        return {
          error: {
            message: `API error: ${error}`,
            type: "api_error"
          }
        };
      }

      // стрим
      if (stream) {
        event.res.setHeader('Content-Type', 'text/event-stream');
        event.res.setHeader('Cache-Control', 'no-cache');
        event.res.setHeader('Connection', 'keep-alive');

        const id = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const encoder = new TextEncoder();

        return new ReadableStream({
          async start(controller) {
            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const jsonStr = trimmed.substring(5).trim();
                if (!jsonStr) continue;

                try {
                  const eventData = JSON.parse(jsonStr);
                  
                  if (eventData.code === 202) {
                    const chunk = {
                      id,
                      created,
                      model,
                      object: 'chat.completion.chunk',
                      choices: [{
                        index: 0,
                        delta: {
                          ...(eventData.data.content && { content: eventData.data.content }),
                          ...(model_id === 1 && eventData.data.reasoning_content && { 
                            reasoning_content: eventData.data.reasoning_content 
                          })
                        }
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                  else if (eventData.code === 203) {
                    const stopChunk = {
                      id,
                      created,
                      model,
                      object: 'chat.completion.chunk',
                      choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  }
                } catch (e) {
                  // ошибки парсинга
                }
              }
            }
            controller.close();
          }
        });
      } 
      // обычный ответ
      else {
        let content = '';
        let reasoningContent = '';
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.substring(5).trim();
            if (!jsonStr) continue;

            try {
              const eventData = JSON.parse(jsonStr);
              if (eventData.code === 202) {
                if (eventData.data.content) content += eventData.data.content;
                if (model_id === 1 && eventData.data.reasoning_content) {
                  reasoningContent += eventData.data.reasoning_content;
                }
              }
            } catch (e) {
              // ошибки парсинга
            }
          }
        }

        return {
          id: `chatcmpl-${crypto.randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: 'chat.completion',
          choices: [{
            message: {
              role: 'assistant',
              content,
              ...(model_id === 1 && { reasoning_content: reasoningContent })
            },
            finish_reason: 'stop',
            index: 0
          }]
        };
      }
    } catch (e: any) {
      event.res.statusCode = 500;
      return {
        error: {
          message: `Internal error: ${e.message}`,
          type: "internal_error"
        }
      };
    }
  }

  // запросы на другие эндпоинты
  const headers = getRequestHeaders(event);
  const body = method !== 'GET' ? await readRawBody(event) : null;

  const lowerCaseHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  // удаление конфликтующих заголовков
  delete lowerCaseHeaders['host'];
  delete lowerCaseHeaders['content-length'];

  const res = await fetch(PROXY_URL + url.pathname + url.search, {
    method: method,
    headers: {
      ...lowerCaseHeaders,
      ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {})
    },
    body: body
  });

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
});
