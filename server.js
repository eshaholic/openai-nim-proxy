const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// [1] 환경변수
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// [필수] 용량 제한 및 CORS 상세 설정
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORS 설정을 더 구체적으로 명시
app.use(cors({
  origin: true, // 요청이 들어온 도메인을 그대로 허용 (가장 확실함)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// 모델 매핑
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1-0528',
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'gemini-pro': 'deepseek-ai/deepseek-r1' 
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Unified AI Proxy', port: PORT });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  models.push({ id: 'gemini-3-pro', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-3-flash-preview', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-1.5-flash', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-1.5-pro', object: 'model', owned_by: 'google' });
  
  res.json({ object: 'list', data: models });
});

// =================================================================
// 🚀 통합 채팅 처리 구간
// =================================================================
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, temperature, max_tokens, stream } = req.body;

  // ---------------------------------------------------------------
  // [A] Gemini 처리 구간 (버퍼링 모드: 끊김 완전 해결)
  // ---------------------------------------------------------------
  if (model && model.toLowerCase().includes('gemini')) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API Key missing");
        return res.status(500).json({ error: "Gemini API Key is missing (Check Env Var Typo!)" });
    }

    try {
      console.log(`🔹 Gemini Request (Buffer Mode): ${model}`);

      // 1. 메시지 변환
      let systemInstruction = undefined;
      const contents = [];

      for (const msg of messages) {
          if (msg.role === 'system') {
              systemInstruction = { parts: [{ text: msg.content }] };
          } else {
              const role = msg.role === 'assistant' ? 'model' : 'user';
              contents.push({
                  role: role,
                  parts: [{ text: msg.content }]
              });
          }
      }

      // 2. 요청 본문 (Native 포맷)
      const nativeBody = {
          contents: contents,
          systemInstruction: systemInstruction,
          generationConfig: {
              temperature: temperature || 0.7,
              maxOutputTokens: max_tokens || 8192,
              candidateCount: 1
          },
          // 🛡️ 안전 설정: 검열 완전 해제
          safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
      };

      // 3. Native URL (generateContent 사용 - 스트림 아님!)
      // *중요: streamGenerateContent 대신 generateContent를 써서 한방에 받습니다.*
      const targetModel = model.startsWith('gemini') ? model : 'gemini-1.5-flash';
      const nativeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_API_KEY}`;

      // 4. 구글에 요청 (await로 끝까지 기다림)
      const response = await axios.post(nativeUrl, nativeBody, {
        headers: { 'Content-Type': 'application/json' }
      });

      // 5. 응답 추출
      const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      // 6. Janitor에게 응답 전송
      if (stream) {
          // Janitor가 스트리밍을 원하면, 우리가 받은 전체 텍스트를 스트리밍인 척 보냅니다.
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          // 한 방에 다 보내기 (끊김 없음)
          const chunk = {
              id: "chatcmpl-" + Date.now(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null
              }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          
          // 종료 신호
          res.write('data: [DONE]\n\n');
          res.end();
      } else {
          // 일반 JSON 응답
          res.json({
              id: "chatcmpl-" + Date.now(),
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                  index: 0,
                  message: { role: "assistant", content: text },
                  finish_reason: "stop"
              }]
          });
      }

    } catch (error) {
      console.error("Gemini Error:", error.message);
      if (error.response) {
          console.error("Error Detail:", JSON.stringify(error.response.data));
          // 구글 에러를 그대로 클라이언트에 전달
          return res.status(error.response.status).json(error.response.data);
      }
      return res.status(500).json({ error: "Gemini Upstream Error" });
    }
  }

  // ---------------------------------------------------------------
  // [B] NVIDIA 처리 구간
  // ---------------------------------------------------------------
  try {
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-405b-instruct';

    // 요청 구성 (원본 유지)
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    console.log(`🔸 NVIDIA Request: ${nimModel}`);

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity, 
      maxContentLength: Infinity 
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('NVIDIA Proxy error:', error.message);
    if (error.response) {
        console.error('Error status:', error.response.status);
        console.error('Error data:', JSON.stringify(error.response.data).substring(0, 200));
    }

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
